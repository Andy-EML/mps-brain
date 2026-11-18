import type { PmRow } from '@mps/db/queries';
import { PmDetail } from '@/components/pm-detail';
import { actionByText, actionText, statusLabel, statusTone } from '@/components/pm-status';
import { ToneBadge } from '@/components/tone-badge';

export interface PmCardProps {
  /** False when the device has no Vantage equipment link. */
  linked: boolean;
  /** True when the device is hidden from the PM list. */
  hidden?: boolean;
  /** Null when the linked machine is not on an active contract (or has no PM data). */
  row: PmRow | null;
  /** Settings behind the "Too short (<45 min)" and "12 months since last visit" wording. */
  qualifyingMinutes: number;
  timeCapMonths: number;
}

/**
 * The device page's "Preventive maintenance" card: status, any open booked / dismissed action as
 * one line, then the shared PM detail (`PmDetail`). Read-only here — Mark booked, Dismiss and Undo
 * live on `/pm`; nothing is ever written to Vantage.
 */
export function PmCard({ linked, hidden = false, row, qualifyingMinutes, timeCapMonths }: PmCardProps) {
  const res = row?.result ?? null;

  return (
    <section className="rounded-xl border border-line bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-5 py-4">
        <h2 className="text-[15px] font-medium">Preventive maintenance</h2>
        {res && row ? (
          <span className="flex flex-wrap items-center gap-1.5">
            {row.bookedOverdue ? (
              <ToneBadge tone="critical" className="px-2 py-0.5 text-[12px]">
                Booked — no visit seen
              </ToneBadge>
            ) : null}
            <ToneBadge tone={statusTone(res.status)} className="px-2 py-0.5 text-[12px]">
              {statusLabel(res.status)}
            </ToneBadge>
          </span>
        ) : null}
      </div>

      {!linked ? (
        <p className="border-t border-line px-5 py-8 text-center text-sm text-muted-foreground">
          Link this device to Vantage to see PM
        </p>
      ) : row === null || res === null ? (
        <p className="border-t border-line px-5 py-8 text-center text-sm text-muted-foreground">
          {hidden ? 'Hidden device — not in the PM list' : 'Not on an active contract, so no PM is tracked for this machine.'}
        </p>
      ) : (
        <>
          {row.action ? (
            <p className="border-t border-line px-5 py-3 text-[13px]">
              {actionText(row.action)}
              <span className="ml-2 text-muted-foreground">{actionByText(row.action)}</span>
            </p>
          ) : null}
          <PmDetail row={row} qualifyingMinutes={qualifyingMinutes} timeCapMonths={timeCapMonths} />
        </>
      )}
    </section>
  );
}
