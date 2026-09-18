export type AlarmCategory = 'toner' | 'waste' | 'parts' | 'service' | 'jam' | 'other';

const CATEGORY_BY_PREFIX: Record<string, AlarmCategory> = {
  TN: 'toner',
  TS: 'toner',
  TO: 'waste',
  TR: 'waste',
  TP: 'parts',
  SC: 'service',
  SR: 'service',
  TV: 'service',
  JF: 'jam',
  FW: 'jam',
};

function extractPrefix(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^([A-Za-z]{2})-/.exec(value.trim());
  return match ? match[1]!.toUpperCase() : null;
}

/**
 * Categorises a DRMS alarm from its `FcCode` prefix (e.g. `TN-00` -> toner, `TO-00`/`TR-00` ->
 * waste, `TP-*` -> parts (imaging units/drums/filters), `SC-*`/`SR-*`/`TV-*` -> service,
 * `JF-*`/`FW-*` -> jam; anything else, including numeric codes like `09-1156`, -> other.
 *
 * `description` is a defensive fallback for the rare case `fcCode` is missing/blank but the
 * description text still starts with the code (e.g. "TP-01 PartsLife(IU_M) 2nd Call").
 */
export function classifyAlarm(fcCode: string | null | undefined, description?: string | null): AlarmCategory {
  const prefix = extractPrefix(fcCode) ?? extractPrefix(description);
  return (prefix && CATEGORY_BY_PREFIX[prefix]) || 'other';
}
