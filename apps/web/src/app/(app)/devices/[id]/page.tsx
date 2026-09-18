import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getCounterHistory,
  getDevice,
  listAlerts,
  listDeviceAlarms,
  listDeviceOrders,
  type AlertRow,
  type DeviceOrders,
} from '@mps/db/queries';
import { cn } from 'cn';
import { acknowledgeAlertAction } from '@/app/(app)/alerts/actions';
import { AlarmGroups } from '@/components/alarm-groups';
import { Breadcrumb } from '@/components/breadcrumb';
import { CounterTable } from '@/components/counter-table';
import { DetailCard, DetailRow } from '@/components/detail-card';
import { counterHistoryRows, groupAlarms, meterChannels, rawString } from '@/components/device-detail';
import { OrderHistory } from '@/components/order-history';
import { PageHeader } from '@/components/page-header';
import { deviceStatusLabel, hasRecentAlarm, tonerChannels } from '@/components/toner';
import { ToneBadge } from '@/components/tone-badge';
import { TonerTile } from '@/components/toner-tile';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatDateTime, formatNumber, formatRelative, pluralise } from '@/lib/format';

export const metadata = { title: 'Device · MPS Dashboard' };

/** Rows in the counter-history table, per the brief. */
const HISTORY_ROWS = 30;
/**
 * How far back to ask for counter history. `getCounterHistory` defaults to 90 days; a device that
 * has been quiet for longer would then show an empty history table under populated meter tiles,
 * which reads as a bug. A year covers everything the snapshot table holds.
 */
const HISTORY_DAYS = 365;
/** Alarms are cheap and a device rarely has many; 200 is far above the busiest device we hold (9). */
const ALARM_LIMIT = 200;
/** Orders shown in the table, per the brief. The per-colour headline looks further back itself. */
const ORDER_LIMIT = 10;

/** An unlinked device has no Vantage equipment id, so it can have no orders. */
const NO_ORDERS: DeviceOrders = {
  orders: [],
  lastByColour: { black: null, cyan: null, magenta: null, yellow: null, waste: null },
};

const LINK_METHOD: Record<string, string> = {
  erp_id: 'ERP id match',
  serial: 'Serial match',
  manual: 'Linked by hand',
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The "No meter reading since …" banner, with Task 8's acknowledge action wired into it.
 *
 * Says what we actually know — DRMS collected no counter set — rather than "offline". When an
 * alarm has arrived inside the last 24 h it says so too: the alarm feed refreshes every ~27 min,
 * so that is proof the device is reaching CSRC and only the meter reading is missing.
 */
function NoMeterReadingBanner({ alert, reachingCsrc, lastAlarmAt, now }: {
  alert: AlertRow;
  reachingCsrc: boolean;
  lastAlarmAt: Date | null;
  now: Date;
}) {
  const since = alert.lastSeenReportAt ?? alert.firstDetectedAt;
  // Only the box and the headline take the tone; putting it on the container would tint the
  // Acknowledge button too, which inherits its colour.
  const box = reachingCsrc ? 'border-warn/30 bg-warn/5' : 'border-critical/25 bg-critical/5';
  return (
    <div className={cn('mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-5 py-4', box)}>
      <div className="min-w-0">
        <p className={cn('text-[15px] font-medium', reachingCsrc ? 'text-warn' : 'text-critical')}>
          No meter reading since {formatDateTime(since)}
          {reachingCsrc && lastAlarmAt
            ? `, but an alarm arrived ${formatRelative(lastAlarmAt, now)}, so the device is reaching CSRC`
            : null}
        </p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Open since {formatDateTime(alert.firstDetectedAt)}
          {alert.acknowledgedAt
            ? ` · acknowledged ${formatRelative(alert.acknowledgedAt)}${
                alert.acknowledgedByName ? ` by ${alert.acknowledgedByName}` : ''
              }`
            : null}
        </p>
      </div>
      {alert.acknowledgedAt ? null : (
        // Acknowledging in place, rather than sending the operator to /alerts to find the row they
        // are already looking at. A plain form, so it works without JavaScript.
        <form action={acknowledgeAlertAction} className="shrink-0">
          <input type="hidden" name="alertId" value={alert.id} />
          <input type="hidden" name="drmsId" value={alert.drmsId} />
          <button
            type="submit"
            className="rounded-lg border border-line bg-card px-3.5 py-2 text-sm font-medium hover:bg-muted"
          >
            Acknowledge
          </button>
        </form>
      )}
    </div>
  );
}

function Card({
  title,
  meta,
  action,
  children,
  bare,
}: {
  title: string;
  meta?: string | null;
  action?: React.ReactNode;
  children: React.ReactNode;
  /** True when the body supplies its own padding (tables run to the card edge). */
  bare?: boolean;
}) {
  return (
    <section className="rounded-xl border border-line bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-5 py-4">
        <h2 className="text-[15px] font-medium">
          {title}
          {meta ? <span className="ml-3 text-[13px] font-normal text-muted-foreground">{meta}</span> : null}
        </h2>
        {action}
      </div>
      <div className={bare ? '' : 'px-5 pb-5'}>{children}</div>
    </section>
  );
}

function Meter({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-lg border border-line bg-page/60 px-4 py-3.5">
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <p className="mt-2 text-[26px] leading-none font-semibold tabular">{formatNumber(value)}</p>
    </div>
  );
}

export default async function DeviceDetailPage({ params, searchParams }: PageProps<'/devices/[id]'>) {
  // First statement on purpose: the layout's own `requireUser()` does not gate this page, because
  // Next fetches layout and page data concurrently.
  const user = await requireUser();

  const { id } = await params;
  const query = await searchParams;
  const showAllAlarms = first(query.alarms) === 'all';

  const db = getDb();
  const detail = await getDevice(db, id);
  if (!detail) notFound();

  const vantageEquipmentId = detail.link.vantageEquipmentId;
  // The meters this device has: a mono device never reports `Full Color:Total`, so the page does
  // not ask for it either — nothing downstream can then put an all-em-dash Colour column back.
  const meters = meterChannels(detail.device.isColour);
  const [history, alarms, alerts, orders] = await Promise.all([
    getCounterHistory(db, id, meters.map((m) => m.counter), HISTORY_DAYS),
    listDeviceAlarms(db, id, { limit: ALARM_LIMIT }),
    listAlerts(db, { drmsId: id }),
    // Orders hang off the Vantage equipment, so an unlinked device simply has none.
    vantageEquipmentId == null
      ? Promise.resolve(NO_ORDERS)
      : listDeviceOrders(db, vantageEquipmentId, { limit: ORDER_LIMIT }),
  ]);

  const { device, record, link } = detail;
  const now = new Date();
  const status = deviceStatusLabel(device, now);
  const historyRows = counterHistoryRows(history, meters, HISTORY_ROWS);
  const { groups, hiddenCount } = groupAlarms(alarms, showAllAlarms);
  // Stored type name; it means "no meter reading collected", not "unreachable".
  const noReadingAlert = alerts.find((a) => a.type === 'offline');
  const reachingCsrc = hasRecentAlarm(device, now);

  const name = device.name ?? device.serial ?? device.drmsId;
  const customer = link.customerName ?? device.customerName ?? 'Unknown customer';
  const comServer = rawString(detail.drmsRaw, 'CsrcComServerId');
  const csrcId = rawString(detail.drmsRaw, 'CsrcId');
  const readAt = detail.latestSnapshotAt ?? device.lastCounterAt;
  // Only the cartridges this device has: a mono device has one tile, not four, and asking about
  // CMY here would drop a healthy mono device into the "no counter set yet" empty state below.
  const channels = tonerChannels(device);
  const hasCounters = channels.some((c) => device.toner[c.key] != null);
  const hasMeters = meters.some((m) => device.meters[m.key] != null);

  const subtitle = [
    device.model,
    device.serial ? `Serial ${device.serial}` : null,
    device.status,
    // The brief writes this as "COM <server>", but every real value already begins with COM
    // (`COM_GB502`, `DEFCNTCOM_GB500`), and "COM COM_GB502" reads like a stutter.
    comServer,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <Breadcrumb
        className="mb-3"
        items={[{ label: 'Fleet overview', href: '/' }, { label: customer }, { label: name }]}
      />

      {noReadingAlert ? (
        <NoMeterReadingBanner
          alert={noReadingAlert}
          reachingCsrc={reachingCsrc}
          lastAlarmAt={device.lastAlarmAt}
          now={now}
        />
      ) : null}

      <PageHeader title={name} badge={<ToneBadge tone={status.tone}>{status.text}</ToneBadge>} subtitle={subtitle} />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid min-w-0 gap-4">
          <Card
            title="Toner levels"
            meta={readAt ? `Read ${formatRelative(readAt, now)}` : 'No reading yet'}
          >
            {hasCounters ? (
              // The grid keeps its four columns whatever the device has, so a tile is the same size
              // on a mono device as on a colour one rather than stretching to fill the card.
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {channels.map((channel) => (
                  <TonerTile
                    key={channel.key}
                    label={channel.label}
                    fillClassName={channel.className}
                    level={device.toner[channel.key]}
                  />
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                DRMS has not returned a counter set for this device yet, so there are no toner levels to show.
              </p>
            )}
            {/* DRMS reports no waste-bottle percentage, so the mockup's fifth tile has no source.
                Waste is covered instead by the alarms card below (TO / TR codes). Only worth
                saying when there are tiles for it to sit under. */}
            {hasCounters ? (
              <p className="mt-3 text-[12px] text-muted-foreground">
                DRMS reports no waste-bottle level — waste shows up as an alarm below.
              </p>
            ) : null}
          </Card>

          <Card title="Meters" meta={readAt ? formatDateTime(readAt) : null}>
            {/* Three columns whatever the device reports, so a mono device's two tiles keep the
                same size as every other device's rather than stretching across the card. */}
            <div className="grid gap-3 sm:grid-cols-3">
              {meters.map((meter) => (
                <Meter key={meter.key} label={meter.label} value={device.meters[meter.key]} />
              ))}
            </div>
            {hasMeters ? null : (
              <p className="mt-3 text-[12px] text-muted-foreground">
                No meter readings collected yet — a device reports these once CSRC has connected.
              </p>
            )}
          </Card>

          <Card
            title="Consumables & alarms"
            meta={`${formatNumber(alarms.length)} ${pluralise(alarms.length, 'alarm')} on record`}
            bare
            action={
              hiddenCount > 0 || showAllAlarms ? (
                <Link
                  href={showAllAlarms ? `/devices/${id}` : `/devices/${id}?alarms=all`}
                  scroll={false}
                  className="text-sm font-medium text-brand hover:underline"
                >
                  {showAllAlarms
                    ? 'Hide jams and service calls'
                    : `Show all (${formatNumber(hiddenCount)} more)`}
                </Link>
              ) : null
            }
          >
            {groups.length > 0 ? (
              <AlarmGroups groups={groups} className="border-t border-line" />
            ) : (
              <p className="border-t border-line px-5 py-10 text-center text-sm text-muted-foreground">
                {alarms.length > 0
                  ? 'Only jams and service calls on record — use “Show all” to see them.'
                  : 'No alarms received for this device.'}
              </p>
            )}
          </Card>

          <Card
            title="Consumable orders"
            meta={
              vantageEquipmentId == null
                ? 'Not linked to Vantage'
                : orders.orders.length > 0
                  ? `Last ${formatNumber(orders.orders.length)} ${pluralise(orders.orders.length, 'order')}`
                  : null
            }
            bare
          >
            <OrderHistory
              orders={orders.orders}
              lastByColour={orders.lastByColour}
              emptyMessage={
                vantageEquipmentId == null
                  ? 'Orders are held against Vantage equipment — link this device to see what has been sent.'
                  : undefined
              }
              className="border-t border-line"
            />
          </Card>

          <Card
            title="Counter history"
            meta={
              historyRows.length > 0
                ? `Last ${formatNumber(Math.min(historyRows.length, HISTORY_ROWS))} ${pluralise(
                    historyRows.length,
                    'snapshot',
                  )}`
                : null
            }
            bare
          >
            <CounterTable
              rows={historyRows}
              channels={meters}
              emptyMessage="No counter snapshots have been collected for this device yet."
            />
            {historyRows.length === 1 ? (
              <p className="px-5 pt-1 pb-4 text-[12px] text-muted-foreground">
                One snapshot so far. DRMS issues a new counter set per device as it collects; the table fills
                in as they arrive.
              </p>
            ) : null}
            {/* The mockup's monthly page-volume bar chart needs aggregates that only exist once
                several months of snapshots have accumulated — a later sub-project. */}
          </Card>
        </div>

        <div className="grid gap-4">
          <DetailCard
            title="Links"
            action={
              link.vantageEquipmentId == null ? (
                <Link href="/issues" className="text-[13px] font-medium text-brand hover:underline">
                  Link issues
                </Link>
              ) : null
            }
          >
            <DetailRow label="Vantage id" mono>
              {link.vantageEquipmentId}
            </DetailRow>
            <DetailRow label="Asset number" mono>
              {link.assetNumber}
            </DetailRow>
            <DetailRow label="Customer">{link.customerName ?? device.customerName}</DetailRow>
            <DetailRow label="Location">{link.location}</DetailRow>
            {/* Ruled null: nothing in the schema or the Vantage client carries a contract yet. */}
            <DetailRow label="Contract ref">{detail.contractRef}</DetailRow>
            <DetailRow label="Link method">
              {link.method ? (LINK_METHOD[link.method] ?? link.method) : null}
            </DetailRow>
            <DetailRow label="Linked">{link.linkedAt ? formatDateTime(link.linkedAt) : null}</DetailRow>
          </DetailCard>

          <DetailCard title="Record">
            <DetailRow label="DRMS id" mono>
              {device.drmsId}
            </DetailRow>
            <DetailRow label="ERP id" mono>
              {record.erpId}
            </DetailRow>
            <DetailRow label="CSRC id" mono>
              {csrcId}
            </DetailRow>
            <DetailRow label="Customer ERP id" mono>
              {record.customerErpId}
            </DetailRow>
            <DetailRow label="Communication">{record.communicationType}</DetailRow>
            <DetailRow label="Registered">
              {record.registrationTime ? formatDateTime(record.registrationTime) : null}
            </DetailRow>
            <DetailRow label="First connection">
              {record.initialConnectionTime ? formatDateTime(record.initialConnectionTime) : null}
            </DetailRow>
            <DetailRow label="Last counter">
              {device.lastCounterAt ? formatDateTime(device.lastCounterAt) : null}
            </DetailRow>
            {/* The second signal of life: the alarm feed refreshes every ~27 min, so this moves
                even on a day when no meter reading was collected. */}
            <DetailRow label="Last alarm">
              {device.lastAlarmAt ? formatRelative(device.lastAlarmAt, now) : null}
            </DetailRow>
          </DetailCard>

          {user.role === 'admin' ? (
            <section className="rounded-xl border border-line bg-card px-5 py-4">
              <h2 className="text-[15px] font-medium">Raw data</h2>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Exactly what DRMS and Vantage returned. Admins only.
              </p>
              <details className="group mt-3">
                <summary className="cursor-pointer text-[13px] font-medium text-brand marker:content-none hover:underline">
                  <span className="group-open:hidden">Show DRMS JSON</span>
                  <span className="hidden group-open:inline">Hide DRMS JSON</span>
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-[11px] whitespace-pre-wrap">
                  {JSON.stringify(detail.drmsRaw, null, 2)}
                </pre>
              </details>
              <details className="group mt-2">
                <summary className="cursor-pointer text-[13px] font-medium text-brand marker:content-none hover:underline">
                  <span className="group-open:hidden">Show Vantage JSON</span>
                  <span className="hidden group-open:inline">Hide Vantage JSON</span>
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-[11px] whitespace-pre-wrap">
                  {detail.vantageRaw ? JSON.stringify(detail.vantageRaw, null, 2) : 'Not linked to Vantage equipment.'}
                </pre>
              </details>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
