'use client';

import { useState, type MouseEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
// Types only from @mps/db: its values would pull the database client into the browser bundle.
import type {
  CustomerRow,
  CustomerWarnings,
  MachineStatusRow,
  SiteStatusRow,
} from '@mps/db/queries';
import { cn } from 'cn';
import { loadCustomerMachinesAction, loadCustomerSitesAction } from '@/app/(app)/customers/actions';
import { MachineLines, MachineLinesHead, WarningMark } from '@/components/customer-machines';
import { customerHref } from '@/components/customers';
import { OtherDealerBadge } from '@/components/other-dealer-badge';
import { ToneBadge } from '@/components/tone-badge';
import { Button } from '@/components/ui/button';
import { formatNumber } from '@/lib/format';

const CELL = 'px-4 py-3 align-middle text-[13px]';
/** Anything in a row that does its own thing on click, so the row must not also toggle. */
const OWN_CLICK = 'a, button, input, select, textarea, label, [data-no-row-nav]';
const CHEVRON_BUTTON =
  '-ml-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand/50';

/** Toggles on a click that is not on the row's own links / buttons and did not end a text selection. */
function rowClickToggles(e: MouseEvent<HTMLElement>): boolean {
  if ((e.target as Element).closest(OWN_CLICK)) return false;
  if (window.getSelection()?.toString()) return false;
  return true;
}

type Loaded<T> =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'done'; data: T };

/**
 * A server-action result loaded on demand: `load()` once (the first expand), again only from the
 * error's "Try again". Fetched from the click handler, never an effect.
 */
function useLazy<T>(fetcher: () => Promise<T | { error: string }>, failText: string) {
  const [result, setResult] = useState<Loaded<T>>({ state: 'idle' });
  function load() {
    setResult({ state: 'loading' });
    fetcher().then(
      (res) =>
        setResult(
          res && typeof res === 'object' && 'error' in res
            ? { state: 'error', error: res.error }
            : { state: 'done', data: res as T },
        ),
      () => setResult({ state: 'error', error: failText }),
    );
  }
  return { result, load };
}

/** The open / rendered state of one accordion: the panel renders on first open and stays mounted. */
function useAccordion(onFirstOpen: () => void) {
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  function toggle() {
    setOpen((o) => !o);
    if (!rendered) {
      setRendered(true);
      onFirstOpen();
    }
  }
  return { open, rendered, toggle };
}

function Chevron({
  open,
  panelId,
  label,
  onClick,
}: {
  open: boolean;
  panelId: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={label}
      onClick={onClick}
      className={CHEVRON_BUTTON}
    >
      <ChevronRight
        aria-hidden
        className={cn('size-4 transition-transform', open && 'rotate-90')}
      />
    </button>
  );
}

function LoadState<T>({
  result,
  retry,
  loadingText,
  children,
}: {
  result: Loaded<T>;
  retry: () => void;
  loadingText: string;
  children: (data: T) => ReactNode;
}) {
  if (result.state === 'done') return <>{children(result.data)}</>;
  if (result.state === 'error') {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px] text-destructive"
      >
        {result.error}
        <Button type="button" size="sm" variant="outline" onClick={retry} className="h-8 px-3">
          Try again
        </Button>
      </div>
    );
  }
  return (
    <p role="status" className="px-4 py-3 text-[13px] text-muted-foreground">
      {loadingText}
    </p>
  );
}

export interface CustomerAccordionRowProps {
  row: CustomerRow;
  warnings: CustomerWarnings;
  /** The list view's own URL: the customer and device links come back to it. */
  back: string;
  /** Columns in the collapsed row, for the panel's colSpan. */
  columns: number;
  /** The row's other `<td>` cells (Ref onwards); the Name cell is drawn here. */
  children: ReactNode;
}

/**
 * One `/customers` row as an accordion, like the Toner orders and PM lists: the Name cell has the
 * chevron button (the keyboard way in: Enter / Space, `aria-expanded`), the name as a link to the
 * customer page and a red ! when any machine has a warning. Clicking anywhere else on the row
 * toggles it. The panel loads on first open — the customer's machine lines, or for a head office
 * (on any tab) its own machines and its sites, each site opening onto its machines — and stays
 * mounted after.
 */
export function CustomerAccordionRow({
  row,
  warnings,
  back,
  columns,
  children,
}: CustomerAccordionRowProps) {
  const isHeadOffice = row.sites > 0;
  // A head office's Machines count and ! include its sites, so on every tab it opens onto its
  // own machines and its sites.
  const withSites = isHeadOffice;
  const id = String(row.vantageId);
  const machines = useLazy<MachineStatusRow[]>(
    () => loadCustomerMachinesAction(id),
    "Couldn't load machines — try again",
  );
  const sites = useLazy<SiteStatusRow[]>(
    () => loadCustomerSitesAction(id),
    "Couldn't load sites — try again",
  );
  const { open, rendered, toggle } = useAccordion(() => {
    machines.load();
    if (withSites) sites.load();
  });
  const panelId = `customer-panel-${row.vantageId}`;
  const name = row.name ?? `Customer ${row.vantageId}`;
  const href = customerHref(row.vantageId, back);

  return (
    <>
      <tr
        onClick={(e) => rowClickToggles(e) && toggle()}
        className={cn(
          'cursor-pointer border-b border-line transition-colors hover:bg-muted/40',
          // The last summary row is followed only by its (hidden) panel row.
          open ? 'border-b-0 bg-muted/30' : '[&:nth-last-child(2)]:border-b-0',
        )}
      >
        <td className={cn(CELL, 'max-w-[320px]')}>
          <span className="flex min-w-0 items-center gap-1.5">
            <Chevron
              open={open}
              panelId={panelId}
              label={`${open ? 'Hide' : 'Show'} ${withSites ? 'sites' : 'machines'} for ${name}`}
              onClick={toggle}
            />
            <Link
              href={href}
              className="min-w-0 truncate font-medium hover:text-brand hover:underline"
            >
              {name}
            </Link>
            <WarningMark warnings={warnings} customerName={row.name} isHeadOffice={isHeadOffice} />
          </span>
          {row.deleted ? (
            <ToneBadge tone="critical" dot={false} className="mt-1 ml-6 px-2 py-0.5 text-[11px]">
              Deleted in Vantage
            </ToneBadge>
          ) : null}
          <OtherDealerBadge info={row.otherDealer} className="mt-1 ml-6 px-2 py-0.5 text-[11px]" />
        </td>
        {children}
      </tr>
      <tr id={panelId} hidden={!open} className="border-b border-line bg-muted/30 last:border-b-0">
        <td colSpan={columns} className="px-4 pt-1 pb-4">
          {rendered ? (
            <div className="ml-6 overflow-hidden rounded-lg border border-line bg-card">
              {withSites ? (
                <>
                  <LoadState
                    result={machines.result}
                    retry={machines.load}
                    loadingText="Loading machines…"
                  >
                    {(data) =>
                      data.length > 0 ? (
                        <section aria-label="Head office machines" className="border-b border-line">
                          <h3 className="px-4 pt-3 text-[12px] font-medium text-muted-foreground">
                            Head office machines
                          </h3>
                          <MachineLinesHead />
                          <MachineLines machines={data} back={back} />
                        </section>
                      ) : null
                    }
                  </LoadState>
                  <LoadState result={sites.result} retry={sites.load} loadingText="Loading sites…">
                    {(data) => <SiteLines sites={data} back={back} />}
                  </LoadState>
                </>
              ) : (
                <LoadState
                  result={machines.result}
                  retry={machines.load}
                  loadingText="Loading machines…"
                >
                  {(data) => (
                    <>
                      {data.length > 0 ? <MachineLinesHead /> : null}
                      <MachineLines machines={data} back={back} />
                    </>
                  )}
                </LoadState>
              )}
              <p className="border-t border-line px-4 py-2.5 text-[13px]">
                <Link href={href} className="text-brand hover:underline">
                  Open customer page →
                </Link>
              </p>
            </div>
          ) : null}
        </td>
      </tr>
    </>
  );
}

function SiteLines({ sites, back }: { sites: SiteStatusRow[]; back: string }) {
  if (sites.length === 0)
    return <p className="px-4 py-3 text-[13px] text-muted-foreground">No sites</p>;
  return (
    <section aria-label="Sites">
      <h3 className="px-4 pt-3 pb-1 text-[12px] font-medium text-muted-foreground">Sites</h3>
      <ul className="divide-y divide-line border-t border-line">
        {sites.map((s) => (
          <li key={s.customer.vantageId}>
            <SiteLine site={s} back={back} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A head office's site: its figures and ! , expanding (lazily, once) onto its own machine lines. */
function SiteLine({
  site: { customer: c, warnings },
  back,
}: {
  site: SiteStatusRow;
  back: string;
}) {
  const machines = useLazy<MachineStatusRow[]>(
    () => loadCustomerMachinesAction(String(c.vantageId)),
    "Couldn't load machines — try again",
  );
  const { open, rendered, toggle } = useAccordion(machines.load);
  const panelId = `customer-site-panel-${c.vantageId}`;
  const name = c.name ?? `Customer ${c.vantageId}`;
  const href = customerHref(c.vantageId, back);
  return (
    <div>
      <div
        onClick={(e) => rowClickToggles(e) && toggle()}
        className={cn(
          'flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[13px] hover:bg-muted/40',
          open && 'bg-muted/30',
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <Chevron
            open={open}
            panelId={panelId}
            label={`${open ? 'Hide' : 'Show'} machines for ${name}`}
            onClick={toggle}
          />
          <Link
            href={href}
            className="min-w-0 truncate font-medium hover:text-brand hover:underline"
          >
            {name}
          </Link>
          <WarningMark warnings={warnings} customerName={c.name} isHeadOffice={false} />
          <OtherDealerBadge info={c.otherDealer} className="px-2 py-0.5 text-[11px]" />
        </span>
        <span className="text-muted-foreground">{c.town ?? '—'}</span>
        <span className="text-muted-foreground tabular-nums">
          {formatNumber(c.machines)} {c.machines === 1 ? 'machine' : 'machines'} ·{' '}
          {formatNumber(c.pending)} pending
        </span>
      </div>
      <div id={panelId} hidden={!open} className="border-t border-line bg-muted/20 pl-8">
        {rendered ? (
          <LoadState result={machines.result} retry={machines.load} loadingText="Loading machines…">
            {(data) => (
              <>
                {data.length > 0 ? <MachineLinesHead /> : null}
                <MachineLines machines={data} back={back} />
              </>
            )}
          </LoadState>
        ) : null}
      </div>
    </div>
  );
}
