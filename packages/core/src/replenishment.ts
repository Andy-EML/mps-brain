/**
 * The replenishment engine: which consumables a device should get a proposal for, and why not.
 * Pure — no I/O. The settings arrive already resolved (the cascade lives in SQL,
 * `effectiveSettingsSubquery`), so this never re-implements it.
 */

export const REPLENISH_COLOURS = ['black', 'cyan', 'magenta', 'yellow', 'waste'] as const;
export const TONER_COLOURS = ['black', 'cyan', 'magenta', 'yellow'] as const;
export type ReplenishColour = (typeof REPLENISH_COLOURS)[number];
export type TonerColour = (typeof TONER_COLOURS)[number];

/** Vantage CreateConsumableOrder `Type`. */
export const CONSUMABLE_TYPE: Record<ReplenishColour, 1 | 2 | 3 | 4 | 5> = {
  black: 1,
  cyan: 2,
  magenta: 3,
  yellow: 4,
  waste: 5,
};

/** Only alarms DRMS has cleared for ERP delivery count; the rest are CSRC-side noise. */
export const READY_FOR_ERP = 'ReadyForErpDelivery';
/** (default) An alarm older than this no longer proposes anything. */
export const ALARM_WINDOW_DAYS = 7;
/** (agreed) No new proposal for a colour within this many days of an order for it completing. */
export const COMPLETED_SUPPRESS_DAYS = 14;
/** (default) A rejected colour stays quiet this long, unless a newer alarm arrives. */
export const REJECTED_SUPPRESS_DAYS = 7;

const DAY_MS = 86_400_000;

const BRACKET_COLOUR: Record<string, TonerColour> = { K: 'black', BK: 'black', C: 'cyan', M: 'magenta', Y: 'yellow' };

/**
 * The consumable a DRMS alarm asks for. Toner alarms name their colour in a trailing bracket —
 * "Toner Near Empty(K)", "Toner Delivery(BK)" — and waste alarms need no colour. Parts, service
 * and jam alarms never propose: a drum or imaging unit needs an engineer, not a sales order.
 */
export function alarmColour(a: { category: string | null; description: string | null; fcCode?: string | null }): ReplenishColour | null {
  if (a.category === 'waste') return 'waste';
  if (a.category !== 'toner') return null;
  const m = /\((BK|K|C|M|Y)\)\s*$/i.exec(a.description ?? '');
  return m ? (BRACKET_COLOUR[m[1]!.toUpperCase()] ?? null) : null;
}

export interface ConsumableAlarm {
  alarmId: string;
  receivedAt: Date;
  category: string | null;
  status: string | null;
  description: string | null;
  fcCode: string | null;
}

export interface ColourHistory {
  /** A `pending`/`approved` proposal already exists for this device + colour. */
  liveProposal: boolean;
  /** An open Vantage order line, or one of our orders still in flight. */
  hasOpenOrder: boolean;
  lastCompletedAt: Date | null;
  lastRejectedAt: Date | null;
}

export interface DeviceReplenishInput {
  vantageEquipmentId: number | null;
  isColour: boolean;
  autoReplenish: boolean;
  thresholds: Record<TonerColour, number>;
  levels: Record<TonerColour, number | null>;
  alarms: ConsumableAlarm[];
  history: Partial<Record<ReplenishColour, ColourHistory>>;
  now: Date;
}

export interface ProposalCandidate {
  colour: ReplenishColour;
  trigger: 'threshold' | 'alarm';
  level: number | null;
  threshold: number | null;
  alarmId: string | null;
  alarmDescription: string | null;
}

export type SuppressReason = 'live_proposal' | 'open_order' | 'recently_completed' | 'recently_rejected';

export interface DeviceEvaluation {
  candidates: ProposalCandidate[];
  suppressed: { colour: ReplenishColour; reason: SuppressReason }[];
  skipped: 'auto_off' | 'unlinked' | null;
}

export function isRecovered(level: number | null, threshold: number): boolean {
  return level !== null && level >= threshold;
}

function channels(isColour: boolean): ReplenishColour[] {
  return isColour ? [...REPLENISH_COLOURS] : ['black', 'waste'];
}

/** The newest ready alarm per colour inside the window. */
function latestAlarms(alarms: ConsumableAlarm[], now: Date): Map<ReplenishColour, ConsumableAlarm> {
  const since = now.getTime() - ALARM_WINDOW_DAYS * DAY_MS;
  const out = new Map<ReplenishColour, ConsumableAlarm>();
  for (const a of alarms) {
    if (a.status !== READY_FOR_ERP || a.receivedAt.getTime() < since) continue;
    const colour = alarmColour(a);
    if (!colour) continue;
    const prev = out.get(colour);
    if (!prev || a.receivedAt > prev.receivedAt) out.set(colour, a);
  }
  return out;
}

function suppression(
  h: ColourHistory | undefined,
  now: Date,
  alarm: ConsumableAlarm | undefined,
): SuppressReason | null {
  if (!h) return null;
  if (h.liveProposal) return 'live_proposal';
  if (h.hasOpenOrder) return 'open_order';
  if (h.lastCompletedAt && now.getTime() - h.lastCompletedAt.getTime() < COMPLETED_SUPPRESS_DAYS * DAY_MS) {
    return 'recently_completed';
  }
  if (h.lastRejectedAt && now.getTime() - h.lastRejectedAt.getTime() < REJECTED_SUPPRESS_DAYS * DAY_MS) {
    const newerAlarm = alarm !== undefined && alarm.receivedAt > h.lastRejectedAt;
    if (!newerAlarm) return 'recently_rejected';
  }
  return null;
}

export function evaluateDevice(input: DeviceReplenishInput): DeviceEvaluation {
  if (!input.autoReplenish) return { candidates: [], suppressed: [], skipped: 'auto_off' };
  if (input.vantageEquipmentId === null) return { candidates: [], suppressed: [], skipped: 'unlinked' };

  const alarms = latestAlarms(input.alarms, input.now);
  const candidates: ProposalCandidate[] = [];
  const suppressed: DeviceEvaluation['suppressed'] = [];

  for (const colour of channels(input.isColour)) {
    const alarm = alarms.get(colour);
    const level = colour === 'waste' ? null : input.levels[colour];
    const threshold = colour === 'waste' ? null : input.thresholds[colour];
    const byThreshold = level !== null && threshold !== null && level < threshold;
    if (!byThreshold && !alarm) continue;

    const reason = suppression(input.history[colour], input.now, alarm);
    if (reason) {
      suppressed.push({ colour, reason });
      continue;
    }
    candidates.push({
      colour,
      trigger: byThreshold ? 'threshold' : 'alarm',
      level: byThreshold ? level : (level ?? null),
      threshold: byThreshold ? threshold : (threshold ?? null),
      alarmId: alarm?.alarmId ?? null,
      alarmDescription: alarm?.description ?? null,
    });
  }
  return { candidates, suppressed, skipped: null };
}
