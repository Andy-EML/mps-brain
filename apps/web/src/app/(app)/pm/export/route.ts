import { getPmSettings, listPmDue, overdueMonths, type BoardColumnStored } from '@mps/db/queries';
import { dismissReasonLabel, reasonText, statusLabel, visitReferences } from '@/components/pm-status';
import { requireUser } from '@/lib/auth';
import { toCsv } from '@/lib/csv';
import { getDb } from '@/lib/db';
import { formatIsoDateTime } from '@/lib/format';
import { applyPmView, parsePmFilters } from '../filters';

export const dynamic = 'force-dynamic';

const HEADERS = [
  'Customer',
  'Town',
  'Serial',
  'Model',
  'Family',
  'Interval (pages)',
  'Interval from',
  'Last qualifying visit (UK time)',
  'Visit minutes',
  'Visit reference',
  'Pages since',
  'Pages since is a minimum',
  '% used',
  'Est. due (UK time)',
  'Time cap (UK time)',
  'Status',
  'Reason',
  'PM booked for (UK time)',
  'Frequent visits',
  'Hold lifts (UK time)',
  'Action',
  'Action by',
  'Action date (UK time)',
  'Booked for (UK time)',
  'Reference',
  'Dismiss reason',
  'Snooze until (UK time)',
  'Serviced outside Vantage on (UK time)',
  'Booked — no visit seen',
  'Priority',
  'When in area',
  'Overdue (months)',
  'On plan',
  'Other dealer',
  'DRMS id',
  'Vantage equipment id',
];

const BOARD_LABEL: Record<BoardColumnStored, string> = { to_plan: 'To plan', asked: 'Asked engineer', done: 'Done' };

const isoDay = (d: Date | null): string => formatIsoDateTime(d).slice(0, 10);

/** The "PM due" tab the operator is looking at (same view, status, filters and search), every row. */
export async function GET(request: Request) {
  // Route handlers sit outside the (app) layout, so the session check is this handler's own.
  // `requireUser` redirects to /login when signed out, exactly as it does for a page.
  await requireUser();

  const filters = parsePmFilters(new URL(request.url).searchParams);
  const db = getDb();
  const now = new Date();
  const [all, settings] = await Promise.all([
    // Every row of every dealer, like the page: the tab (incl. When in area / Other dealer) is applied by applyPmView.
    listPmDue(db, now, { view: 'all', dealer: 'all', customer: filters.customer, family: filters.family, q: filters.q }),
    getPmSettings(db),
  ]);
  const rows = applyPmView(all, filters, now, settings);

  const csv = toCsv(
    HEADERS,
    rows.map((r) => {
      const res = r.result;
      const v = res.lastQualifying;
      const a = r.action;
      const dismissReason = a?.reason ? `${dismissReasonLabel(a.reason)}${a.note ? `: ${a.note}` : ''}` : null;
      return [
        r.customerName,
        r.town,
        r.serial,
        r.model,
        r.family,
        r.intervalPages,
        r.intervalSource,
        v ? formatIsoDateTime(v.at) : '',
        v?.minutes != null ? Math.round(v.minutes) : null,
        v ? visitReferences(v).join(', ') || null : null,
        res.pagesSince === null ? null : Math.round(res.pagesSince),
        res.pagesSince === null ? '' : res.pagesSinceIsLowerBound ? 'yes' : 'no',
        res.pctUsed === null ? null : Math.round(res.pctUsed * 100),
        isoDay(res.estDueDate),
        isoDay(res.timeCapDate),
        statusLabel(res.status),
        reasonText(res.reason, settings.timeCapMonths, res.clockSource),
        isoDay(res.status === 'booked' ? res.bookedFor : null),
        res.status === 'held' ? res.frequentVisits : null,
        isoDay(res.status === 'held' ? res.holdUntil : null),
        a ? (a.kind === 'booked' ? 'Booked' : 'Dismissed') : null,
        a?.createdByName ?? null,
        a ? formatIsoDateTime(a.createdAt) : '',
        isoDay(a?.bookedFor ?? null),
        a?.reference ?? null,
        dismissReason,
        isoDay(a?.snoozeUntil ?? null),
        isoDay(a?.servicedOn ?? null),
        r.bookedOverdue ? 'yes' : '',
        r.plan.priority ? 'yes' : '',
        r.plan.whenInArea ? 'yes' : '',
        overdueMonths(r, now),
        r.plan.boardColumn ? BOARD_LABEL[r.plan.boardColumn] : '',
        r.otherDealer.dealer,
        r.drmsEquipmentId,
        r.vantageEquipmentId,
      ];
    }),
  );

  const today = isoDay(now);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="pm-${filters.view}-${today}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
