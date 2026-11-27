// Types only from @mps/db: the panel also renders in client components (the lazy loader).
import type { DeviceParts } from '@mps/db/queries';
import { cn } from 'cn';
import { TONE_TEXT } from '@/components/status-dot';
import { ToneBadge } from '@/components/tone-badge';
import { TONER_CHANNELS, newCartridgeNote } from '@/components/toner';
import { TonerBar } from '@/components/toner-bar';
import {
  lastFittedText,
  lastVisitLine,
  partPagesText,
  partAlarmDateText,
  partRowLabel,
  partStateLabel,
  partStateTitle,
  partStateTone,
  pctLeftText,
  pctLeftTone,
  ratedLifeNote,
} from '@/components/parts-status';
import { formatDate, formatNumber, formatRelative } from '@/lib/format';

const HEAD = 'px-1.5 py-1 text-left align-bottom text-[11px] font-medium text-muted-foreground';
const CELL = 'px-1.5 py-1 align-top';

export interface PartsPanelProps {
  data: DeviceParts;
  /** Off on the device page, which already has a Toner levels card. */
  showToner?: boolean;
  className?: string;
}

/**
 * Wear parts and toner for one machine, compact enough for the PM map's side panel: pages now and
 * the last visit, the machine's own PM-counter warning, toner bars, then one row per part with its
 * DRMS alarm state, estimated life left, last fitted (from Vantage visits) and pages since. No
 * hooks, so it renders on the server (device page) or the client (lazy loader).
 */
export function PartsPanel({ data: d, showToner = true, className }: PartsPanelProps) {
  const channels = d.isColour ? TONER_CHANNELS : TONER_CHANNELS.filter((c) => c.key === 'black');
  const present = new Set(channels.map((c) => c.key));
  const hasToner = channels.some((c) => d.toner[c.key] !== null);
  const note = ratedLifeNote(d);

  return (
    <div className={cn('space-y-3 text-[13px]', className)}>
      <p className="text-[12px] text-muted-foreground">
        {d.pagesNow !== null ? (
          <>
            <span className="text-foreground tabular-nums">{formatNumber(Math.round(d.pagesNow))}</span> pages ·{' '}
          </>
        ) : null}
        {lastVisitLine(d.lastVisit)}
      </p>

      {d.pmCountWarning ? (
        <p role="status" className={cn('rounded-md bg-warn/10 px-2.5 py-1.5 text-[12px]', TONE_TEXT.warn)}>
          Machine&apos;s own PM counter is due (alarm {formatDate(d.pmCountWarning.receivedAt)}), no field visit since.
        </p>
      ) : null}

      {showToner ? (
        <div>
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            Toner{d.toner.readAt ? ` · read ${formatRelative(d.toner.readAt)}` : ''}
          </p>
          {hasToner ? (
            <div className="grid grid-cols-4 gap-3">
              {TONER_CHANNELS.map((c) =>
                present.has(c.key) ? (
                  <TonerBar key={c.key} level={d.toner[c.key]} fillClassName={c.className} label={c.label} note={newCartridgeNote(d.toner.newCartridge?.[c.key])} />
                ) : (
                  <div key={c.key} aria-hidden />
                ),
              )}
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground">No toner reading from DRMS.</p>
          )}
        </div>
      ) : null}

      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-line">
            <th className={cn(HEAD, 'pl-0')}>Part</th>
            <th className={HEAD}>State</th>
            <th className={cn(HEAD, 'text-right')}>Est. life left</th>
            <th className={HEAD}>Last fitted</th>
            <th className={cn(HEAD, 'pr-0 text-right')}>Pages since</th>
          </tr>
        </thead>
        <tbody>
          {d.parts.map((p) => {
            const pct = pctLeftText(p.pctLeft);
            const pctTone = pctLeftTone(p.pctLeft);
            const pages = partPagesText(p.pagesSince, p.pagesSinceEstimated);
            return (
              <tr key={`${p.part}:${p.colour ?? ''}`} className="border-b border-line/60 last:border-0">
                <td className={cn(CELL, 'pl-0 whitespace-nowrap')}>{partRowLabel(p)}</td>
                <td className={CELL}>
                  <span title={partStateTitle(p)}>
                    <ToneBadge tone={partStateTone(p.state)} dot={false} className="px-1.5 py-0 text-[11px]">
                      {partStateLabel(p.state)}
                    </ToneBadge>
                    {p.alarm ? <span className="ml-1.5 tabular-nums text-muted-foreground">{partAlarmDateText(p)}</span> : null}
                  </span>
                </td>
                <td
                  className={cn(CELL, 'text-right tabular-nums whitespace-nowrap', pctTone && TONE_TEXT[pctTone])}
                  title={p.ratedLife !== null ? `Rated ${formatNumber(p.ratedLife)} pages` : undefined}
                >
                  {pct}
                </td>
                <td className={cn(CELL, 'tabular-nums', p.lastFitted ? 'whitespace-nowrap' : 'text-muted-foreground')}>
                  {lastFittedText(p.lastFitted)}
                </td>
                <td
                  className={cn(CELL, 'pr-0 text-right tabular-nums whitespace-nowrap')}
                  title={p.pagesSinceEstimated ? 'Meter at the fit estimated between two readings' : undefined}
                >
                  {pages}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}
