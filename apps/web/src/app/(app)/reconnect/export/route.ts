import { listReconnect } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { toCsv } from '@/lib/csv';
import { getDb } from '@/lib/db';
import { formatIsoDateTime } from '@/lib/format';
import { monitoringGroupLabel, parseReconnectFilter } from '../filters';

export const dynamic = 'force-dynamic';

const HEADERS = [
  'Customer',
  'Customer reference',
  'Location',
  'Asset number',
  'Device',
  'Model',
  'Serial',
  'DRMS status',
  'Monitoring',
  'Last contact (UK time)',
  'Days silent',
  'Last alarm (UK time)',
  'First connected (UK time)',
  'DRMS id',
  'Vantage equipment id',
];

/** The "Needs reconnecting" view the operator is looking at (same filter and search), every row. */
export async function GET(request: Request) {
  // Route handlers sit outside the (app) layout, so the session check is this handler's own.
  // `requireUser` redirects to /login when signed out, exactly as it does for a page.
  await requireUser();

  const url = new URL(request.url);
  const filter = parseReconnectFilter(url.searchParams.get('filter'));
  const search = url.searchParams.get('search')?.trim() || undefined;

  const now = new Date();
  const { rows } = await listReconnect(getDb(), { filter, search, now });

  const csv = toCsv(
    HEADERS,
    rows.map((r) => [
      r.customerName,
      r.customerReference,
      r.location,
      r.assetNumber,
      r.name,
      r.model,
      r.serial,
      r.drmsStatus,
      r.hasMeterReadings ? 'Silent' : monitoringGroupLabel(r.registeredInDrms),
      formatIsoDateTime(r.lastContactAt),
      r.daysSilent,
      formatIsoDateTime(r.lastAlarmAt),
      formatIsoDateTime(r.firstConnectedAt),
      r.drmsId,
      r.vantageEquipmentId,
    ]),
  );

  const today = formatIsoDateTime(now).slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="needs-reconnecting-${today}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
