import { SITE_STOCK_CSV_HEADERS } from '@mps/core';
import { listSiteStockExportRows } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { toCsv } from '@/lib/csv';
import { getDb } from '@/lib/db';
import { formatIsoDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Every site + cartridge family in the fleet, with its shelf's holdings and used counts (zeros
 * where there is no shelf yet), so the file doubles as a fill-in template for the import. Columns
 * are `SITE_STOCK_CSV_HEADERS`, the names the import reads.
 */
export async function GET() {
  // Route handlers sit outside the (app) layout, so the session check is this handler's own.
  await requireUser();

  const csv = toCsv([...SITE_STOCK_CSV_HEADERS], await listSiteStockExportRows(getDb()));

  const today = formatIsoDateTime(new Date()).slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="site-stock-${today}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
