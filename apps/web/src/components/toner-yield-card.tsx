import Link from 'next/link';
import type { ColourYield, DeviceYield } from '@mps/db/queries';
import { cn } from 'cn';
import { colourLabel } from '@/components/colour-chip';
import { Swatch } from '@/components/review-detail-panel';
import {
  CARTRIDGE_FAMILIES_HREF,
  avgAchievedText,
  cartridgeRows,
  pagesSinceCell,
} from '@/components/toner-yield';
import { ToneBadge } from '@/components/tone-badge';
import { formatDate, formatDateTime, formatNumber, pluralise } from '@/lib/format';

const HEAD = 'px-5 py-2 text-left text-[11px] font-medium tracking-wider text-muted-foreground uppercase whitespace-nowrap';
const CELL = 'px-5 py-3 align-top text-[13px]';

export interface TonerYieldCardProps {
  /** Null when the device has no yield data at all (should not happen for a device that exists). */
  data: DeviceYield | null;
  /** Vantage sales-order id to its reference, for the orders this page already loaded. */
  orderRefs: Record<number, string | null>;
}

/**
 * The device page's "Toner yield" card: per colour, the rated yield, the average pages a cartridge
 * actually did, the last order and pages since, with *Early?* and *Under-yielding* flags; below, the
 * recent cartridges of each colour behind a disclosure. Every unknown figure says why it is unknown.
 */
export function TonerYieldCard({ data, orderRefs }: TonerYieldCardProps) {
  const colours = data?.colours ?? [];
  const noRated = colours.some((c) => c.status === 'no_rated_yield');
  const unlinked = data !== null && data.vantageEquipmentId === null;

  return (
    <section className="rounded-xl border border-line bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-5 py-4">
        <h2 className="text-[15px] font-medium">
          Toner yield
          {data?.familyName ? (
            <span className="ml-3 text-[13px] font-normal text-muted-foreground">{data.familyName}</span>
          ) : null}
        </h2>
        {data?.stale ? (
          <span
            title={
              data.latestSnapshotAt
                ? `Newest meter reading ${formatDateTime(data.latestSnapshotAt)}, so pages since the last order may be understated.`
                : 'No meter readings collected for this device.'
            }
          >
            <ToneBadge tone="muted" dot={false} className="px-2 py-0.5 text-[12px]">
              {data.latestSnapshotAt ? 'Stale meters' : 'No meter readings'}
            </ToneBadge>
          </span>
        ) : null}
      </div>

      {data === null || unlinked ? (
        <p className="border-t border-line px-5 py-8 text-center text-sm text-muted-foreground">
          Yield is worked out from Vantage sales orders — link this device to Vantage equipment to see it.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={HEAD}>Colour</th>
                  <th className={HEAD}>Rated</th>
                  <th className={HEAD}>Avg achieved</th>
                  <th className={HEAD}>Last order</th>
                  <th className={HEAD}>Pages since</th>
                  <th className={HEAD}>
                    <span className="sr-only">Flags</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {colours.map((c) => (
                  <ColourRow key={c.colour} c={c} />
                ))}
              </tbody>
            </table>
          </div>

          {noRated ? (
            <p className="border-t border-line px-5 py-3 text-[12px] text-muted-foreground">
              {data.familyId === null
                ? `${data.modelName ?? 'This model'} is not in a cartridge family, so it has no rated yields. `
                : `Rated yields are not entered for ${data.familyName ?? 'this cartridge family'}. `}
              <Link href={CARTRIDGE_FAMILIES_HREF} className="font-medium text-brand hover:underline">
                {data.familyId === null ? 'Add it to a family' : 'Enter them on Cartridge families'}
              </Link>{' '}
              to see % of rated and the early and under-yielding flags.
            </p>
          ) : null}

          <div className="grid gap-1 border-t border-line px-5 py-3">
            {colours
              .filter((c) => c.cartridges.length > 0)
              .map((c) => (
                <CartridgeList key={c.colour} c={c} orderRefs={orderRefs} />
              ))}
            {colours.every((c) => c.cartridges.length === 0) ? (
              <p className="text-[13px] text-muted-foreground">No toner orders on record for this device.</p>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function ColourRow({ c }: { c: ColourYield }) {
  const unknownAvg = c.avgAchieved === null;
  const unknownSince = c.lastOrderDate !== null && c.pagesSinceLastOrder === null;
  return (
    <tr className="border-t border-line/70">
      <td className={cn(CELL, 'whitespace-nowrap')}>
        <span className="flex items-center gap-2 font-medium">
          <Swatch colour={c.colour} />
          {colourLabel(c.colour)}
        </span>
      </td>
      <td className={cn(CELL, 'tabular-nums')}>
        {c.ratedYield !== null ? formatNumber(c.ratedYield) : <span className="text-muted-foreground">Not set</span>}
      </td>
      <td className={cn(CELL, 'tabular-nums', unknownAvg && 'text-muted-foreground')}>
        {avgAchievedText(c)}
        {c.avgAchieved !== null ? (
          <span className="block text-[12px] text-muted-foreground">
            over {formatNumber(c.cartridgesCounted)} {pluralise(c.cartridgesCounted, 'cartridge')}
          </span>
        ) : null}
      </td>
      <td className={cn(CELL, 'whitespace-nowrap tabular-nums')}>
        {c.lastOrderDate ? formatDate(c.lastOrderDate) : <span className="text-muted-foreground">—</span>}
      </td>
      <td className={cn(CELL, 'tabular-nums', unknownSince && 'text-muted-foreground')}>{pagesSinceCell(c)}</td>
      <td className={cn(CELL, 'text-right')}>
        <span className="inline-flex flex-wrap justify-end gap-1">
          {c.early === true ? (
            <ToneBadge tone="warn" dot={false} className="px-2 py-0 text-[11px]">
              <span title="Under half a rated cartridge printed since the last order">Early?</span>
            </ToneBadge>
          ) : null}
          {c.underYielding === true ? (
            <ToneBadge tone="critical" dot={false} className="px-2 py-0 text-[11px]">
              <span title="Average pages per cartridge under 70% of rated">Under-yielding</span>
            </ToneBadge>
          ) : null}
        </span>
      </td>
    </tr>
  );
}

function CartridgeList({ c, orderRefs }: { c: ColourYield; orderRefs: Record<number, string | null> }) {
  const rows = cartridgeRows(c);
  return (
    <details className="group">
      <summary className="flex cursor-pointer items-center gap-2 py-1 text-[13px] font-medium text-brand marker:content-none hover:underline">
        <Swatch colour={c.colour} />
        <span className="group-open:hidden">Show</span>
        <span className="hidden group-open:inline">Hide</span>
        {colourLabel(c.colour).toLowerCase()} cartridges
        <span className="font-normal text-muted-foreground">
          ({formatNumber(c.cartridges.length)} {pluralise(c.cartridges.length, 'delivery', 'deliveries')})
        </span>
      </summary>
      <div className="mt-1 mb-2 overflow-x-auto rounded-lg border border-line">
        <table className="w-full">
          <thead>
            <tr>
              <th className={HEAD}>Ordered</th>
              <th className={HEAD}>Qty</th>
              <th className={HEAD}>Sales order</th>
              <th className={HEAD}>Pages</th>
              <th className={HEAD}>Per cartridge</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-line/70">
                <td className={cn(CELL, 'py-2 whitespace-nowrap tabular-nums')}>{formatDate(r.orderDate)}</td>
                <td className={cn(CELL, 'py-2 tabular-nums')}>{formatNumber(r.quantity)}</td>
                <td className={cn(CELL, 'py-2 font-mono text-[12px]')}>{orderRefs[r.salesOrderId] ?? `#${r.salesOrderId}`}</td>
                <td className={cn(CELL, 'py-2 tabular-nums', !/^\d/.test(r.pagesText) && 'text-muted-foreground')}>{r.pagesText}</td>
                <td className={cn(CELL, 'py-2 tabular-nums')}>{r.perCartridgeText}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
