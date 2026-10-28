import type { DeviceListOptions } from '@mps/db/queries';

/**
 * The device list's customer, colour, model and replenishment filters, as URL search params. The
 * Devices page and the Fleet overview read them from the URL, and the bulk bar posts them back to
 * `bulkUpdateSettingsAction`, which reads them from the form — all three through `parseDeviceFilters`,
 * so a value the page would ignore cannot reach the query from the form either.
 */
export type DeviceFilters = Pick<DeviceListOptions, 'customer' | 'colour' | 'model' | 'replenish'>;

export const COLOUR_FILTERS = [
  { value: 'colour', label: 'Colour' },
  { value: 'mono', label: 'Mono' },
] as const satisfies readonly { value: NonNullable<DeviceFilters['colour']>; label: string }[];

export const REPLENISH_FILTERS = [
  { value: 'auto-off', label: 'Auto-replenish off' },
  { value: 'site-stock', label: 'On a site stock shelf' },
] as const satisfies readonly { value: NonNullable<DeviceFilters['replenish']>; label: string }[];

/** Longer than any customer or model name; anything bigger is not one of ours. */
const MAX_LENGTH = 200;

function name(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= MAX_LENGTH ? trimmed : undefined;
}

function oneOf<T extends string>(value: string | undefined, choices: readonly { value: T }[]): T | undefined {
  return choices.find((c) => c.value === value)?.value;
}

/** The filters from a param getter (URL search params or a form); anything unknown is dropped. */
export function parseDeviceFilters(get: (param: string) => string | undefined): DeviceFilters {
  return {
    customer: name(get('customer')),
    colour: oneOf(get('colour'), COLOUR_FILTERS),
    model: name(get('model')),
    replenish: oneOf(get('replenish'), REPLENISH_FILTERS),
  };
}

/** The filters as URL params, for `hrefWith`; unset ones are left off. */
export function deviceFilterParams(f: DeviceFilters): Record<string, string | undefined> {
  return { customer: f.customer, colour: f.colour, model: f.model, replenish: f.replenish };
}

export function hasDeviceFilters(f: DeviceFilters): boolean {
  return Object.values(deviceFilterParams(f)).some((v) => v !== undefined);
}
