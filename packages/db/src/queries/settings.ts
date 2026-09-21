import { and, count, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../client';
import { auditLog, deviceLinks, drmsEquipment, replenishmentSettings, users, vantageCustomers, vantageEquipment } from '../schema';

export type SettingSource = 'device' | 'customer' | 'default';

export type SettingsErrorCode = 'invalid_threshold' | 'empty_patch' | 'default_null' | 'no_devices';

/** Anything an operator can get wrong from the UI; always safe to show them. */
export class SettingsError extends Error {
  constructor(
    message: string,
    readonly code: SettingsErrorCode,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

const THRESHOLD_KEYS = ['thresholdBlack', 'thresholdCyan', 'thresholdMagenta', 'thresholdYellow'] as const;
const FLAG_KEYS = ['autoReplenish', 'alertsEnabled'] as const;
const SETTING_KEYS = [...THRESHOLD_KEYS, ...FLAG_KEYS] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

/** Key absent = leave alone; `null` = inherit from the level above. */
export type SettingsPatch = {
  thresholdBlack?: number | null;
  thresholdCyan?: number | null;
  thresholdMagenta?: number | null;
  thresholdYellow?: number | null;
  autoReplenish?: boolean | null;
  alertsEnabled?: boolean | null;
};

const dev = alias(replenishmentSettings, 'rs_device');
const cus = alias(replenishmentSettings, 'rs_customer');
const def = alias(replenishmentSettings, 'rs_default');

function resolved<T>(key: SettingKey) {
  return sql<T>`coalesce(${dev[key]}, ${cus[key]}, ${def[key]})`;
}
function source(key: SettingKey) {
  return sql<SettingSource>`case when ${dev[key]} is not null then 'device' when ${cus[key]} is not null then 'customer' else 'default' end`;
}

/**
 * One row per DRMS device with every effective setting and where it came from. THE place the
 * cascade is expressed: the engine, fleet counts, devices filters, the queue and the device page
 * all read this, so they cannot disagree. Left-join it (or select from it) on `drmsId`.
 */
export function effectiveSettingsSubquery(db: Db) {
  return db
    .select({
      drmsId: drmsEquipment.drmsId,
      vantageEquipmentId: deviceLinks.vantageEquipmentId,
      vantageCustomerId: vantageEquipment.vantageCustomerId,
      thresholdBlack: resolved<number>('thresholdBlack').as('eff_threshold_black'),
      thresholdBlackSource: source('thresholdBlack').as('eff_threshold_black_source'),
      thresholdCyan: resolved<number>('thresholdCyan').as('eff_threshold_cyan'),
      thresholdCyanSource: source('thresholdCyan').as('eff_threshold_cyan_source'),
      thresholdMagenta: resolved<number>('thresholdMagenta').as('eff_threshold_magenta'),
      thresholdMagentaSource: source('thresholdMagenta').as('eff_threshold_magenta_source'),
      thresholdYellow: resolved<number>('thresholdYellow').as('eff_threshold_yellow'),
      thresholdYellowSource: source('thresholdYellow').as('eff_threshold_yellow_source'),
      autoReplenish: resolved<boolean>('autoReplenish').as('eff_auto_replenish'),
      autoReplenishSource: source('autoReplenish').as('eff_auto_replenish_source'),
      alertsEnabled: resolved<boolean>('alertsEnabled').as('eff_alerts_enabled'),
      alertsEnabledSource: source('alertsEnabled').as('eff_alerts_enabled_source'),
    })
    .from(drmsEquipment)
    .leftJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .leftJoin(dev, and(eq(dev.scope, 'device'), eq(dev.drmsEquipmentId, drmsEquipment.drmsId)))
    .leftJoin(cus, and(eq(cus.scope, 'customer'), eq(cus.vantageCustomerId, vantageEquipment.vantageCustomerId)))
    // Exactly one default row (unique index + seed), so this is a one-row cross join.
    .innerJoin(def, eq(def.scope, 'default'))
    .as('effective_settings');
}

// Deviation from the brief: the brief's `validatePatch` returns `Partial<Record<SettingKey,
// unknown>>`, which does not compile — spreading `unknown`-valued fields into `.values()`/`.set()`
// fails to satisfy Drizzle's per-column insert/update types (TS2322/TS2769). Returning the exact
// `SettingsPatch` shape (which already matches each column's nullable type) fixes it; the runtime
// validation is unchanged, only the return type. The per-field assignment still needs a cast since
// TS cannot correlate `key: SettingKey` with `v`'s narrowed type inside the loop.
function validatePatch(patch: SettingsPatch, { allowNull }: { allowNull: boolean }): SettingsPatch {
  const out: SettingsPatch = {};
  const bag = out as Record<SettingKey, number | boolean | null>;
  for (const key of SETTING_KEYS) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === undefined) continue;
    if (v === null) {
      if (!allowNull) throw new SettingsError('The default settings cannot inherit from anything.', 'default_null');
      bag[key] = null;
      continue;
    }
    if ((THRESHOLD_KEYS as readonly string[]).includes(key)) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) {
        throw new SettingsError('A threshold is a whole percentage from 0 to 100.', 'invalid_threshold');
      }
    }
    bag[key] = v;
  }
  if (Object.keys(out).length === 0) throw new SettingsError('Nothing to change.', 'empty_patch');
  return out;
}

/** Delete scoped rows that no longer override anything. */
function allNull(): SQL {
  return and(...SETTING_KEYS.map((k) => isNull(replenishmentSettings[k])))!;
}

async function audit(tx: Db, userId: number, entity: string, ids: (string | number)[], patch: object, now: Date) {
  await tx.insert(auditLog).values({ at: now, userId, action: 'settings.update', entity, entityIds: ids, details: { patch } });
}

export async function updateDeviceSettings(
  db: Db,
  args: { drmsIds: string[]; patch: SettingsPatch; userId: number; now?: Date },
): Promise<{ updated: number }> {
  const now = args.now ?? new Date();
  const ids = [...new Set(args.drmsIds)];
  if (ids.length === 0) throw new SettingsError('Select at least one device.', 'no_devices');
  const values = validatePatch(args.patch, { allowNull: true });

  await db.transaction(async (tx) => {
    for (const drmsEquipmentId of ids) {
      await tx
        .insert(replenishmentSettings)
        .values({ scope: 'device', drmsEquipmentId, ...values, updatedBy: args.userId, updatedAt: now })
        .onConflictDoUpdate({
          target: replenishmentSettings.drmsEquipmentId,
          targetWhere: sql`scope = 'device'`,
          set: { ...values, updatedBy: args.userId, updatedAt: now },
        });
    }
    await tx
      .delete(replenishmentSettings)
      .where(and(eq(replenishmentSettings.scope, 'device'), inArray(replenishmentSettings.drmsEquipmentId, ids), allNull()));
    await audit(tx as unknown as Db, args.userId, 'device', ids, values, now);
  });
  return { updated: ids.length };
}

export async function updateCustomerSettings(
  db: Db,
  args: { vantageCustomerId: number; patch: SettingsPatch; userId: number; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  const values = validatePatch(args.patch, { allowNull: true });
  await db.transaction(async (tx) => {
    await tx
      .insert(replenishmentSettings)
      .values({ scope: 'customer', vantageCustomerId: args.vantageCustomerId, ...values, updatedBy: args.userId, updatedAt: now })
      .onConflictDoUpdate({
        target: replenishmentSettings.vantageCustomerId,
        targetWhere: sql`scope = 'customer'`,
        set: { ...values, updatedBy: args.userId, updatedAt: now },
      });
    await tx
      .delete(replenishmentSettings)
      .where(and(eq(replenishmentSettings.scope, 'customer'), eq(replenishmentSettings.vantageCustomerId, args.vantageCustomerId), allNull()));
    await audit(tx as unknown as Db, args.userId, 'customer', [args.vantageCustomerId], values, now);
  });
}

export async function updateDefaultSettings(db: Db, args: { patch: SettingsPatch; userId: number; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  const values = validatePatch(args.patch, { allowNull: false });
  await db.transaction(async (tx) => {
    await tx
      .update(replenishmentSettings)
      .set({ ...values, updatedBy: args.userId, updatedAt: now })
      .where(eq(replenishmentSettings.scope, 'default'));
    await audit(tx as unknown as Db, args.userId, 'default', [], values, now);
  });
}

export interface SettingsRowMeta {
  updatedAt: Date;
  updatedBy: string | null;
}

export interface EffectiveSettings {
  thresholds: Record<'black' | 'cyan' | 'magenta' | 'yellow', { value: number; source: SettingSource }>;
  autoReplenish: { value: boolean; source: SettingSource };
  alertsEnabled: { value: boolean; source: SettingSource };
  vantageCustomerId: number | null;
  deviceRow: SettingsRowMeta | null;
  customerRow: SettingsRowMeta | null;
}

async function rowMeta(db: Db, where: SQL): Promise<SettingsRowMeta | null> {
  const [row] = await db
    .select({ updatedAt: replenishmentSettings.updatedAt, updatedBy: users.username })
    .from(replenishmentSettings)
    .leftJoin(users, eq(users.id, replenishmentSettings.updatedBy))
    .where(where);
  return row ?? null;
}

export async function getDeviceSettings(db: Db, drmsId: string): Promise<EffectiveSettings | null> {
  const eff = effectiveSettingsSubquery(db);
  const [r] = await db.select().from(eff).where(eq(eff.drmsId, drmsId));
  if (!r) return null;
  const [deviceRow, customerRow] = await Promise.all([
    rowMeta(db, and(eq(replenishmentSettings.scope, 'device'), eq(replenishmentSettings.drmsEquipmentId, drmsId))!),
    r.vantageCustomerId === null
      ? Promise.resolve(null)
      : rowMeta(db, and(eq(replenishmentSettings.scope, 'customer'), eq(replenishmentSettings.vantageCustomerId, r.vantageCustomerId))!),
  ]);
  return {
    thresholds: {
      black: { value: Number(r.thresholdBlack), source: r.thresholdBlackSource },
      cyan: { value: Number(r.thresholdCyan), source: r.thresholdCyanSource },
      magenta: { value: Number(r.thresholdMagenta), source: r.thresholdMagentaSource },
      yellow: { value: Number(r.thresholdYellow), source: r.thresholdYellowSource },
    },
    autoReplenish: { value: Boolean(r.autoReplenish), source: r.autoReplenishSource },
    alertsEnabled: { value: Boolean(r.alertsEnabled), source: r.alertsEnabledSource },
    vantageCustomerId: r.vantageCustomerId,
    deviceRow,
    customerRow,
  };
}

export interface CustomerSettingsRow {
  vantageCustomerId: number;
  customerName: string | null;
  reference: string | null;
  deviceCount: number;
  thresholdBlack: number | null;
  thresholdCyan: number | null;
  thresholdMagenta: number | null;
  thresholdYellow: number | null;
  autoReplenish: boolean | null;
  alertsEnabled: boolean | null;
  updatedAt: Date;
  updatedBy: string | null;
}

/** Customer overrides, with how many linked DRMS devices each one reaches. */
export async function listCustomerSettings(db: Db): Promise<CustomerSettingsRow[]> {
  const devices = db
    .select({ customerId: vantageEquipment.vantageCustomerId, n: count().as('device_count') })
    .from(deviceLinks)
    .innerJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .where(isNull(deviceLinks.unlinkedAt))
    .groupBy(vantageEquipment.vantageCustomerId)
    .as('customer_devices');

  const rows = await db
    .select({
      vantageCustomerId: replenishmentSettings.vantageCustomerId,
      customerName: vantageCustomers.name,
      reference: vantageCustomers.reference,
      deviceCount: devices.n,
      thresholdBlack: replenishmentSettings.thresholdBlack,
      thresholdCyan: replenishmentSettings.thresholdCyan,
      thresholdMagenta: replenishmentSettings.thresholdMagenta,
      thresholdYellow: replenishmentSettings.thresholdYellow,
      autoReplenish: replenishmentSettings.autoReplenish,
      alertsEnabled: replenishmentSettings.alertsEnabled,
      updatedAt: replenishmentSettings.updatedAt,
      updatedBy: users.username,
    })
    .from(replenishmentSettings)
    .leftJoin(vantageCustomers, eq(vantageCustomers.vantageId, replenishmentSettings.vantageCustomerId))
    .leftJoin(devices, eq(devices.customerId, replenishmentSettings.vantageCustomerId))
    .leftJoin(users, eq(users.id, replenishmentSettings.updatedBy))
    .where(eq(replenishmentSettings.scope, 'customer'))
    .orderBy(vantageCustomers.name);

  return rows.map((r) => ({ ...r, vantageCustomerId: r.vantageCustomerId!, deviceCount: Number(r.deviceCount ?? 0) }));
}
