import { SettingsError } from '@mps/db/queries';

/**
 * The `/pm` row's planner forms (Priority star, When in area / Back to Due, Add to plan, Mark as
 * ours) as one shape. Pure. Fields: `vantageEquipmentId` (required, `^\d{1,10}$`, at least 1), `on`
 * (`'true'` / `'false'`, for the toggles) and `vantageCustomerId` (for Mark as ours). A refusal
 * throws `SettingsError('invalid_pm_action')`, the code the other `/pm` forms use.
 */

export interface PlanForm {
  vantageEquipmentId: number;
  /** The toggle's new state; null when the form has no `on` field. */
  on: boolean | null;
  /** The site, for Mark as ours; null when the form has none. */
  vantageCustomerId: number | null;
}

function text(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : null;
}

function bad(): never {
  throw new SettingsError('That PM action is not valid — check the form and try again.', 'invalid_pm_action');
}

function id(raw: string | null): number {
  if (raw === null || !/^\d{1,10}$/.test(raw) || Number(raw) < 1) bad();
  return Number(raw);
}

export function parsePlanForm(formData: FormData): PlanForm {
  const vantageEquipmentId = id(text(formData, 'vantageEquipmentId'));
  const onRaw = text(formData, 'on');
  if (onRaw !== null && onRaw !== 'true' && onRaw !== 'false') bad();
  const customerRaw = text(formData, 'vantageCustomerId');
  return {
    vantageEquipmentId,
    on: onRaw === null ? null : onRaw === 'true',
    vantageCustomerId: customerRaw === null ? null : id(customerRaw),
  };
}
