'use client';

import type { ReactNode } from 'react';
import type { ReplenishColour } from '@mps/core';
import type { QueueProposal, ReviewDeviceDetail, ReviewTonerColour } from '@mps/db/queries';
import { cn } from 'cn';
import { colourLabel } from '@/components/replenishment';
import { pagesSinceText } from '@/components/review-row';
import { ToneBadge } from '@/components/tone-badge';
import { TonerBar } from '@/components/toner-bar';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';

export const SWATCH: Record<ReplenishColour, string> = {
  black: 'bg-toner-black',
  cyan: 'bg-toner-cyan',
  magenta: 'bg-toner-magenta',
  yellow: 'bg-toner-yellow',
  waste: 'bg-toner-waste',
};

/** The small square from the mockup's cartridge list. */
export function Swatch({ colour, className }: { colour: ReplenishColour; className?: string }) {
  return <span aria-hidden className={cn('size-3 shrink-0 rounded-[3px]', SWATCH[colour], className)} />;
}

const SHORT: Record<ReplenishColour, string> = { black: 'Black', cyan: 'Cyan', magenta: 'Magenta', yellow: 'Yellow', waste: 'Waste' };

export type DetailState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: ReviewDeviceDetail | null };

/**
 * Everything below the proposal lines in an open Review row: toner levels, recent toner orders,
 * recent consumable alarms and pages printed since each proposed colour last went out. Loaded by
 * the row on first open (`loadReviewDetail`) and kept for the life of the page.
 */
export function ReviewDetailPanel({
  state,
  proposals,
  onRetry,
}: {
  state: DetailState;
  proposals: readonly QueueProposal[];
  onRetry: () => void;
}) {
  if (state.status === 'loading') {
    return (
      <p role="status" className="mt-4 text-[13px] text-muted-foreground">
        Loading device detail…
      </p>
    );
  }
  if (state.status === 'error' || state.data === null) {
    return (
      <p role="alert" className="mt-4 text-[13px] text-critical">
        Could not load the device detail.{' '}
        <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
          Try again
        </button>
      </p>
    );
  }
  const d = state.data;
  const proposed = [...new Set(proposals.map((p) => p.colour))].filter((c): c is ReviewTonerColour => c !== 'waste');
  return (
    <div className="mt-4 grid gap-x-8 gap-y-5 md:grid-cols-2">
      <Section title="Toner levels">
        <div className="grid grid-cols-5 gap-3">
          {d.levels.map((l) =>
            l.colour === 'waste' ? (
              <div key={l.colour} className="min-w-0">
                <div className="h-1.5 w-full rounded-full border border-dashed border-line" aria-hidden />
                <div className="mt-1.5 text-xs text-muted-foreground" title="DRMS reports no waste-box level; see alarms">
                  Waste —
                </div>
              </div>
            ) : (
              <div key={l.colour} className="min-w-0">
                <TonerBar level={l.level} fillClassName={SWATCH[l.colour]} label={SHORT[l.colour]} />
                <div className="text-[11px] text-muted-foreground">{SHORT[l.colour]}</div>
              </div>
            ),
          )}
        </div>
        <p className={cn('mt-2 text-[13px]', d.readingStale ? 'text-warn' : 'text-muted-foreground')}>
          {d.lastReadingAt ? `Last DRMS reading ${formatDateTime(d.lastReadingAt)}` : 'No DRMS reading yet'}
          {d.readingStale && d.lastReadingAt ? ' · over 3 days old' : ''}
        </p>
      </Section>

      <Section title="Pages since last order">
        {proposed.length === 0 ? (
          <Empty>Only waste is proposed.</Empty>
        ) : (
          <ul className="grid gap-1.5">
            {proposed.map((c) => {
              const ps = d.pagesSince[c];
              const warn = ps?.kind === 'meter-reset' || ps?.kind === 'no-reading';
              return (
                <li key={c} className="flex items-center gap-2 text-[13px]">
                  <Swatch colour={c} />
                  <span className="w-16 shrink-0">{SHORT[c]}</span>
                  <span className={cn('tabular-nums', warn ? 'text-warn' : 'text-muted-foreground')}>
                    {ps ? pagesSinceText(ps) : '—'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Recent toner orders">
        {d.orders.length === 0 ? (
          <Empty>No toner orders in Vantage for this device.</Empty>
        ) : (
          <ul className="grid gap-1.5">
            {d.orders.map((o) => (
              <li key={o.vantageId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                <span className="w-24 shrink-0 text-muted-foreground tabular-nums">{formatDate(o.orderDate)}</span>
                <span className="w-24 shrink-0 font-mono">{o.reference ?? '—'}</span>
                <span className="flex flex-wrap items-center gap-2">
                  {o.lines.map((l, i) => (
                    <span key={i} className="inline-flex items-center gap-1">
                      <Swatch colour={l.colour} className="size-2.5" />
                      {colourLabel(l.colour)}
                      {l.quantity !== null && l.quantity !== 1 ? ` ×${formatNumber(l.quantity)}` : ''}
                    </span>
                  ))}
                </span>
                <ToneBadge tone={o.open ? 'warn' : 'muted'} dot={false} className="px-2 py-0.5 text-[11px]">
                  {o.open ? 'Open' : 'Completed'}
                </ToneBadge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="DRMS alarms · last 30 days">
        {d.alarms.length === 0 ? (
          <Empty>No toner, waste or parts alarms.</Empty>
        ) : (
          <ul className="grid gap-1.5">
            {d.alarms.map((a) => (
              <li key={a.alarmId} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[13px]">
                <span className="w-32 shrink-0 text-muted-foreground tabular-nums">{formatDateTime(a.receivedTime)}</span>
                <span className="min-w-0 flex-1">{a.description ?? '—'}</span>
                {a.totalCount !== null ? (
                  <span className="text-muted-foreground tabular-nums">
                    {formatNumber(a.totalCount)} pages
                    {d.isColour && a.totalColorCount !== null ? ` · ${formatNumber(a.totalColorCount)} colour` : ''}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className="mb-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-muted-foreground">{children}</p>;
}
