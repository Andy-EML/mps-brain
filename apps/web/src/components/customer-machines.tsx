import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
// Types only from @mps/db: its values would pull the database client into the browser bundle.
import type { CustomerWarnings, MachineStatusRow } from '@mps/db/queries';
import { cn } from 'cn';
import {
  machineLineWarnings,
  machinesEmptyText,
  pmChipText,
  pmChipTone,
  pmWarningHref,
  warningTooltip,
} from '@/components/customer-status';
import { TONE_TEXT } from '@/components/status-dot';
import { ToneBadge } from '@/components/tone-badge';
import { TonerBars } from '@/components/toner-bar';
import { deviceHref } from '@/lib/device-origin';
import { formatDate } from '@/lib/format';

/**
 * The red ! beside a customer's name when any of its machines has a warning; the tooltip lists the
 * counts. When PM is overdue (and the customer is not a head office) it links to `/pm` for that
 * customer. Renders nothing for a clean customer.
 */
export function WarningMark({
  warnings,
  customerName,
  isHeadOffice,
}: {
  warnings: CustomerWarnings;
  customerName: string | null;
  isHeadOffice: boolean;
}) {
  const tooltip = warningTooltip(warnings);
  if (!tooltip) return null;
  const href = warnings.pmOverdue > 0 ? pmWarningHref(customerName, isHeadOffice) : null;
  const icon = <AlertCircle aria-hidden className={cn('size-4', TONE_TEXT.critical)} />;
  if (href) {
    return (
      <Link
        href={href}
        title={`${tooltip} — open PM due`}
        aria-label={`${tooltip}. Open PM due for this customer`}
        className="inline-flex shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
      >
        {icon}
      </Link>
    );
  }
  return (
    <span role="img" title={tooltip} aria-label={tooltip} className="inline-flex shrink-0">
      {icon}
    </span>
  );
}

const LINE =
  'grid items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[13px] md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_160px_minmax(0,1.2fr)_90px]';

/**
 * One line per machine in an expanded customer: model and serial, location, toner bars, PM chip,
 * pending orders and last reading, with any warnings in red underneath. Each line opens the device
 * page, which comes back to `back` (the list view).
 */
export function MachineLines({ machines, back }: { machines: MachineStatusRow[]; back: string }) {
  if (machines.length === 0)
    return <p className="px-4 py-3 text-[13px] text-muted-foreground">{machinesEmptyText()}</p>;
  return (
    <ul className="divide-y divide-line">
      {machines.map((m) => (
        <li key={m.device.drmsId}>
          <MachineLine m={m} back={back} />
        </li>
      ))}
    </ul>
  );
}

function MachineLine({ m, back }: { m: MachineStatusRow; back: string }) {
  const d = m.device;
  const warnings = machineLineWarnings(m);
  return (
    <Link
      href={deviceHref(d.drmsId, 'customers', back)}
      className={cn(
        LINE,
        'transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-brand/50',
      )}
    >
      <span className="min-w-0">
        <span className="block truncate font-medium">{d.model ?? d.displayName}</span>
        <span className="block truncate font-mono text-[12px] text-muted-foreground">
          {d.serial ?? '—'}
        </span>
      </span>
      <span className="min-w-0 truncate text-muted-foreground">{m.location ?? '—'}</span>
      <TonerBars row={d} />
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <PmChip pm={m.pm} />
        {m.pending > 0 ? (
          <span className="text-[12px] text-muted-foreground whitespace-nowrap">
            {m.pending} pending
          </span>
        ) : null}
      </span>
      <span className="text-[12px] text-muted-foreground tabular-nums md:text-right">
        <span className="md:hidden">Last reading </span>
        {formatDate(m.lastReadingAt)}
      </span>
      {warnings.length > 0 ? (
        <span className={cn('text-[12px] font-medium md:col-span-5', TONE_TEXT.critical)}>
          {warnings.join(' · ')}
        </span>
      ) : null}
    </Link>
  );
}

/** The PM chip; at an other-dealer site a muted "Other dealer: MJ Flood" instead of a status (they do its PM). */
function PmChip({ pm }: { pm: MachineStatusRow['pm'] }) {
  if (pm === null) return <span className="text-[12px] text-muted-foreground">No PM</span>;
  return (
    <>
      {pm.bookedOverdue && pm.otherDealer === null ? (
        <ToneBadge tone="critical" className="px-2 py-0.5 text-[12px]">
          Booked — no visit seen
        </ToneBadge>
      ) : null}
      <ToneBadge tone={pmChipTone(pm)} dot={pm.otherDealer === null} className="px-2 py-0.5 text-[12px]">
        {pmChipText(pm)}
      </ToneBadge>
    </>
  );
}

/** The column heads over the machine lines (wide screens only; the lines stack on narrow ones). */
export function MachineLinesHead() {
  return (
    <div
      aria-hidden
      className={cn(
        LINE,
        'hidden border-b border-line py-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase md:grid',
      )}
    >
      <span>Machine</span>
      <span>Location</span>
      <span>Toner</span>
      <span>PM / pending</span>
      <span className="text-right">Last reading</span>
    </div>
  );
}
