/**
 * The sentence for `?hideError=<code>`, from a hide or unhide refused by `hideDevices` /
 * `unhideDevices` (`HideError`) or by the bulk bar's selection cap. An unknown code still reads
 * as something went wrong rather than nothing.
 */
const MESSAGES: Record<string, string> = {
  no_devices: 'Select at least one device.',
  reason_too_long: 'Keep the reason to 500 characters.',
  too_many: 'That is too many devices to post at once — use “Select all matching” instead.',
};

export function hideErrorMessage(code: string): string {
  return MESSAGES[code] ?? 'The devices could not be hidden. Try again.';
}
