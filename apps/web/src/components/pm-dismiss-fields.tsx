'use client';

import { useState } from 'react';
import type { DismissReason } from '@mps/db/queries';
import { DEFAULT_SNOOZE_OPTION, DISMISS_REASONS, SNOOZE_OPTIONS, dismissReasonLabel } from '@/components/pm-status';
import { Input } from '@/components/ui/input';

const FIELD_LABEL = 'mb-1 block text-[12px] text-muted-foreground';

/**
 * The Dismiss inputs shared by the `/pm` row form and the PM map's Dismiss dialog: reason, then
 * either the snooze length or (Serviced outside Vantage) the service date, and a note (required for
 * Other). Field names match `parseDismissForm`; the caller adds `vantageEquipmentId` and the submit
 * button. `footer` sits at the end of the last row (the row form puts its button there).
 */
export function DismissFields({
  idPrefix,
  today,
  footer,
}: {
  /** Makes the input ids unique on the page, e.g. `pm-dismiss-123`. */
  idPrefix: string;
  /** Today in London as `yyyy-mm-dd`: the serviced date's default and latest allowed value. */
  today: string;
  footer?: React.ReactNode;
}) {
  const [reason, setReason] = useState<DismissReason>('not_now');
  const serviced = reason === 'serviced_outside';
  const noteId = `${idPrefix}-note`;
  const servicedId = `${idPrefix}-serviced`;
  return (
    <>
      <p className="mb-3 text-[12px] text-muted-foreground">
        {serviced
          ? 'Restarts the PM clock from the service date, as if a counted visit happened then.'
          : 'Snoozed machines sit in Dismissed, then come back to the list.'}
      </p>
      <fieldset className="mb-3">
        <legend className={FIELD_LABEL}>Reason</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {DISMISS_REASONS.map((value) => (
            <label key={value} className="flex items-center gap-1.5 text-[13px]">
              <input
                type="radio"
                name="reason"
                value={value}
                checked={reason === value}
                onChange={() => setReason(value)}
                className="accent-brand"
              />
              {dismissReasonLabel(value)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        {serviced ? (
          <div>
            <label htmlFor={servicedId} className={FIELD_LABEL}>
              Serviced on
            </label>
            <Input id={servicedId} type="date" name="servicedOn" defaultValue={today} max={today} required className="h-9 w-40" />
          </div>
        ) : (
          <fieldset>
            <legend className={FIELD_LABEL}>Snooze for</legend>
            <div className="flex h-9 items-center gap-3">
              {SNOOZE_OPTIONS.map((days) => (
                <label key={days} className="flex items-center gap-1.5 text-[13px]">
                  <input type="radio" name="snoozeDays" value={days} defaultChecked={days === DEFAULT_SNOOZE_OPTION} className="accent-brand" />
                  {days} days
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="min-w-48 flex-1">
          <label htmlFor={noteId} className={FIELD_LABEL}>
            {reason === 'other' ? 'Note (required)' : 'Note (optional)'}
          </label>
          <Input id={noteId} name="note" maxLength={500} required={reason === 'other'} className="h-9" />
        </div>
        {footer}
      </div>
    </>
  );
}
