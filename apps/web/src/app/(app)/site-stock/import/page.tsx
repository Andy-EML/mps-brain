import { MAX_HOLDING } from '@mps/core';
import { Breadcrumb } from '@/components/breadcrumb';
import { PageHeader } from '@/components/page-header';
import { SiteStockImport } from '@/components/site-stock-import';
import { requireUser } from '@/lib/auth';

export const metadata = { title: 'Import site stock · MPS Dashboard' };

/**
 * `/site-stock/import`, for every signed-in user: bulk-set shelf holdings from a CSV in the
 * export's format. A preview shows what each row would do; *Apply* writes it all in one go.
 */
export default async function SiteStockImportPage() {
  // First statement: the (app) layout's own requireUser() does not gate this page.
  await requireUser();

  return (
    <>
      <Breadcrumb
        className="mb-3"
        items={[{ label: 'Fleet overview', href: '/' }, { label: 'Site stock', href: '/site-stock' }, { label: 'Import CSV' }]}
      />

      <PageHeader
        title="Import site stock"
        subtitle={
          <>
            Start from <a href="/site-stock/export" className="font-medium text-brand hover:underline">Export CSV</a>: it has a row for every
            site and cartridge family in the fleet. Change the <code>hold_</code> columns and upload it here.
          </>
        }
      />

      <ul className="mb-4 list-disc pl-5 text-[13px] text-muted-foreground">
        <li>
          Rows are matched on <code>vantage_customer_id</code> and <code>family</code>; the other name and address columns are only there
          to help you.
        </li>
        <li>
          Holdings are whole numbers from 0 to {MAX_HOLDING}; a blank one is 0. A mono family holds black and waste only.
        </li>
        <li>
          A row holding anything for a site with no shelf yet creates one, and its <code>used_</code> columns are taken as what has
          been used already. For existing shelves the <code>used_</code> columns are ignored: correct those on the shelf.
        </li>
        <li>An unknown customer or family is an error, and nothing is applied until every row is right.</li>
      </ul>

      <SiteStockImport />
    </>
  );
}
