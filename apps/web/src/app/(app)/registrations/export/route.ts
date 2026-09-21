import { listRegistrationLog } from '@mps/db/queries';
import { registrationStatusBadge } from '@/components/registrations';
import { requireUser } from '@/lib/auth';
import { toCsv } from '@/lib/csv';
import { getDb } from '@/lib/db';
import { formatIsoDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

const HEADERS = [
  'Attempt id',
  'Status',
  'Serial',
  'Device',
  'Model',
  'DRMS customer',
  'DRMS customer code',
  'Vantage customer',
  'Vantage equipment id',
  'Customer match',
  'Waiting reason',
  'Found (UK time)',
  'Decided by',
  'Decided (UK time)',
  'Note',
  'Retry requested by',
  'Retry requested (UK time)',
  'Sent (UK time)',
  'DRMS request id',
  'Result / DRMS message',
  'DRMS status after',
  'Finished (UK time)',
  'Request sent',
  'DRMS response',
  'DRMS id',
];

const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

/** Every registration attempt, oldest first, with the exact request sent and DRMS's answer. */
export async function GET() {
  // Route handlers sit outside the (app) layout, so the session check is this handler's own.
  await requireUser();

  const rows = await listRegistrationLog(getDb());
  const csv = toCsv(
    HEADERS,
    rows.map((r) => [
      r.id,
      registrationStatusBadge(r.status).label,
      r.serial,
      r.deviceName,
      r.model,
      r.drmsCustomerName,
      r.customerErpId,
      r.vantageCustomerName,
      r.vantageEquipmentId,
      r.customerMatch,
      r.reason,
      formatIsoDateTime(r.createdAt),
      r.decidedBy,
      formatIsoDateTime(r.decidedAt),
      r.note,
      r.retryRequestedBy,
      formatIsoDateTime(r.retryRequestedAt),
      formatIsoDateTime(r.submittedAt),
      r.requestId,
      r.error,
      r.drmsStatusAfter,
      formatIsoDateTime(r.finishedAt),
      json(r.request),
      json(r.response),
      r.drmsId,
    ]),
  );

  const today = formatIsoDateTime(new Date()).slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="drms-registrations-${today}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
