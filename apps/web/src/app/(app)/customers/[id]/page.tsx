import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Boxes, ChevronRight, PackageX } from 'lucide-react';
import {
  getCustomer,
  getDefaultSettings,
  listCustomerDevices,
  listCustomerOrders,
  listCustomerSettings,
  listCustomerShelves,
  listFamilies,
  previewSelfManaged,
  type CustomerSettingsRow,
  type DefaultSettings,
  type DeviceOrders,
} from '@mps/db/queries';
import { cn } from 'cn';
import { Breadcrumb } from '@/components/breadcrumb';
import { ResetCustomerDialog } from '@/components/customer-override-dialogs';
import { customerHref, customerStockBadge } from '@/components/customers';
import { DeviceTable } from '@/components/device-table';
import { OrderHistory, type OrderMachine } from '@/components/order-history';
import { PageHeader } from '@/components/page-header';
import { SelfManagedSwitch } from '@/components/self-managed-switch';
import { SettingsDialog, type SettingsField, type SettingsHint } from '@/components/settings-dialog';
import { DeleteShelfDialog, HoldingsForm, NewShelfDialog } from '@/components/shelf-forms';
import { ToneBadge } from '@/components/tone-badge';
import { updateCustomerAction } from '@/app/(app)/settings/replenishment/actions';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { deviceHref } from '@/lib/device-origin';
import { formatDate, formatNumber, pluralise } from '@/lib/format';
import { settingsErrorMessage } from '@/lib/settings-form';
import { shelfErrorMessage } from '@/lib/shelf-form';

export const metadata = { title: 'Customer · MPS Dashboard' };

/** Toner orders shown: the last 12 months on the order date. */
const ORDER_MONTHS = 12;

const FIELDS: SettingsField[] = ['black', 'cyan', 'magenta', 'yellow', 'autoReplenish', 'spareBlack', 'alertsEnabled'];

const THRESHOLDS = [
  { field: 'black', key: 'thresholdBlack', label: 'Black' },
  { field: 'cyan', key: 'thresholdCyan', label: 'Cyan' },
  { field: 'magenta', key: 'thresholdMagenta', label: 'Magenta' },
  { field: 'yellow', key: 'thresholdYellow', label: 'Yellow' },
] as const;

const FLAGS = [
  { field: 'autoReplenish', key: 'autoReplenish', label: 'Auto-replenish' },
  { field: 'spareBlack', key: 'spareBlack', label: 'Spare black on site' },
  { field: 'alertsEnabled', key: 'alertsEnabled', label: 'No-meter-reading alerts' },
] as const;

/** The multi-machine order list has no per-colour headline, so this is never shown. */
const NO_HEADLINE: DeviceOrders['lastByColour'] = { black: null, cyan: null, magenta: null, yellow: null, waste: null };

const HEAD = 'px-4 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase whitespace-nowrap';
const CELL = 'px-4 py-3 align-middle text-[13px]';

/** The per-shelf forms an `?errorFor=` can name. */
type ShelfForm = 'holdings' | 'correct' | 'delete';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** What this customer's devices get now, field by field: its override, or the default beneath it. */
function customerHints(row: CustomerSettingsRow | undefined, d: DefaultSettings): Partial<Record<SettingsField, SettingsHint>> {
  const hints: Partial<Record<SettingsField, SettingsHint>> = {};
  for (const { field, key } of [...THRESHOLDS, ...FLAGS]) {
    const own = row ? row[key] : null;
    hints[field] = own === null ? { value: d[key], origin: 'default' } : { value: own, origin: 'this customer' };
  }
  return hints;
}

function Card({
  title,
  meta,
  action,
  children,
  id,
}: {
  title: string;
  meta?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="scroll-mt-6 rounded-xl border border-line bg-card">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 py-4">
        <h2 className="text-[15px] font-medium">
          {title}
          {meta ? <span className="ml-3 text-[13px] font-normal text-muted-foreground">{meta}</span> : null}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function SettingValue({ label, own, fallback }: { label: string; own: string | null; fallback: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-page/60 px-3 py-2.5">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-[15px] font-medium tabular">
        {own ?? fallback}
        <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{own === null ? 'default' : 'this customer'}</span>
      </p>
    </div>
  );
}

/**
 * `/customers/<id>`, for every signed-in user: one Vantage customer (a site, or a head office with
 * its sites) — its self-managed stock switch, customer-level replenishment settings, machines, the
 * last 12 months of toner orders, and its site stock shelves, all editable in place. A head office
 * page covers its own record and every site's. A customer deleted in Vantage 404s unless it has a
 * flag row; then it is shown, badged, so a flag left on it can be turned off.
 *
 * Errors come back from the reused actions as `?settingsError=<code>` (settings dialogs) or
 * `?error=<code>&errorFor=<form>[&shelf=<id>]` (shelf forms); the sentence is looked up here, so a
 * crafted link cannot put text on the page.
 */
export default async function CustomerPage({ params, searchParams }: PageProps<'/customers/[id]'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const { id: rawId } = await params;
  if (!/^\d{1,9}$/.test(rawId)) notFound();
  const id = Number(rawId);
  const query = await searchParams;

  const db = getDb();
  const customer = await getCustomer(db, id);
  if (!customer) notFound();

  const path = customerHref(id);
  const isHeadOffice = customer.sites.length > 0;
  const ids = [id, ...customer.sites.map((s) => s.vantageId)];
  const since = new Date();
  since.setMonth(since.getMonth() - ORDER_MONTHS);

  const [devices, orders, shelves, preview, settingsRows, defaults, families] = await Promise.all([
    listCustomerDevices(db, ids),
    listCustomerOrders(db, ids, since),
    listCustomerShelves(db, ids),
    previewSelfManaged(db, id),
    listCustomerSettings(db),
    getDefaultSettings(db),
    listFamilies(db),
  ]);
  const settings = settingsRows.find((r) => r.vantageCustomerId === id);

  // Errors from the reused actions.
  const settingsErrorCode = first(query.settingsError);
  const settingsError = settingsErrorCode ? settingsErrorMessage(settingsErrorCode) : null;
  const shelfErrorCode = first(query.error);
  const shelfErrorFor = first(query.errorFor);
  const shelfErrorShelf = Number(first(query.shelf) ?? NaN);
  const addError = shelfErrorCode && shelfErrorFor === 'add' ? shelfErrorMessage(shelfErrorCode) : null;
  const shelfErrorIn = (shelfId: number, form: ShelfForm) =>
    shelfErrorCode && shelfErrorFor === form && shelfErrorShelf === shelfId ? shelfErrorMessage(shelfErrorCode) : null;
  // An error for a shelf that is no longer listed (deleted meanwhile) still says something.
  const strayShelfError =
    shelfErrorCode && shelfErrorFor !== 'add' && !shelves.some((s) => s.id === shelfErrorShelf)
      ? shelfErrorMessage(shelfErrorCode)
      : null;

  const name = customer.name ?? `Customer ${id}`;
  const sm = customer.selfManaged;
  const now = new Date();
  // Machines at this customer itself (a head office's sites have their own counts).
  const ownMachines = Math.max(0, devices.visible.length - customer.sites.reduce((n, s) => n + s.machines, 0));
  const anyColour = devices.visible.some((d) => d.isColour) || devices.hidden.some((d) => d.isColour);

  const machineOf: Record<number, OrderMachine | null> = Object.fromEntries(
    orders.map((o) => [
      o.vantageId,
      o.deviceName ? { name: o.deviceName, href: o.drmsId ? deviceHref(o.drmsId, 'customers', path) : null } : null,
    ]),
  );

  const subtitle = [
    customer.reference,
    customer.town,
    customer.postCode,
  ].filter(Boolean).join(' · ');

  return (
    <>
      <Breadcrumb
        className="mb-3"
        items={[
          { label: 'Customers', href: '/customers' },
          ...(customer.headOffice
            ? [{ label: customer.headOffice.name ?? `Customer ${customer.headOffice.vantageId}`, href: customerHref(customer.headOffice.vantageId) }]
            : []),
          { label: name },
        ]}
      />

      <Link href="/customers" className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-brand hover:underline">
        <ArrowLeft aria-hidden className="size-3.5" />
        Back to Customers
      </Link>

      <PageHeader
        title={name}
        badge={
          <>
            {customer.deleted ? <ToneBadge tone="critical" dot={false}>Deleted in Vantage</ToneBadge> : null}
            {isHeadOffice ? <ToneBadge tone="muted" dot={false}>Head office</ToneBadge> : null}
            {customer.isOnStop ? <ToneBadge tone="critical">On stop</ToneBadge> : null}
          </>
        }
        subtitle={
          <>
            {subtitle || 'No reference or town in Vantage'}
            {customer.headOffice ? (
              <>
                {' · Head office '}
                <Link href={customerHref(customer.headOffice.vantageId)} className="font-medium text-brand hover:underline">
                  {customer.headOffice.name ?? `Customer ${customer.headOffice.vantageId}`}
                </Link>
              </>
            ) : null}
          </>
        }
        actions={
          <SelfManagedSwitch
            vantageCustomerId={id}
            customerName={name}
            on={sm.source === 'site'}
            viaHeadOffice={sm.source === 'head_office' ? customer.headOffice : null}
            preview={preview}
          />
        }
      />

      {sm.selfManaged ? (
        <div className="mb-5 flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/5 px-5 py-4">
          <PackageX aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
          <div className="min-w-0">
            <p className="text-[15px] font-medium text-warn">
              Self-managed stock — no toner proposals for this customer’s machines
            </p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {sm.source === 'head_office' && customer.headOffice ? (
                <>
                  Via head office{' '}
                  <Link href={customerHref(customer.headOffice.vantageId)} className="font-medium text-brand hover:underline">
                    {customer.headOffice.name ?? `Customer ${customer.headOffice.vantageId}`}
                  </Link>
                  {' · '}
                </>
              ) : null}
              {[
                sm.updatedBy ? `Turned on by ${sm.updatedBy}` : 'Turned on',
                sm.updatedAt ? formatDate(sm.updatedAt) : null,
              ]
                .filter(Boolean)
                .join(', ')}
              {sm.note ? <span className="text-foreground"> — “{sm.note}”</span> : null}
            </p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Cartridge changes and shelf uses are still recorded. Approved and in-progress orders are untouched.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4">
        <Card
          id="settings"
          title="Settings"
          meta={
            isHeadOffice
              ? 'Customer level — applies to this head office’s own machines; each site has its own'
              : 'Customer level — applies to every machine here without a setting of its own'
          }
          action={
            <div className="flex items-center gap-2">
              <SettingsDialog
                title={`Replenishment settings for ${name}`}
                description="Applies to every device of this customer that has no setting of its own. Leave a field on Keep to leave it as it is; Inherit uses the default again."
                fields={FIELDS}
                initial={customerHints(settings, defaults)}
                allowInherit
                isColour
                action={updateCustomerAction}
                hidden={{ vantageCustomerId: String(id), returnTo: path }}
                error={settingsError}
              />
              {settings ? (
                <ResetCustomerDialog
                  vantageCustomerId={id}
                  customerName={name}
                  deviceCount={settings.deviceCount}
                  returnTo={path}
                />
              ) : null}
            </div>
          }
        >
          <div className="grid gap-2 px-5 pb-5 sm:grid-cols-4 xl:grid-cols-7">
            {THRESHOLDS.map((t) => (
              <SettingValue
                key={t.key}
                label={`${t.label} threshold`}
                own={settings && settings[t.key] !== null ? `${settings[t.key]}%` : null}
                fallback={`${defaults[t.key]}%`}
              />
            ))}
            {FLAGS.map((f) => (
              <SettingValue
                key={f.key}
                label={f.label}
                own={settings && settings[f.key] !== null ? (settings[f.key] ? 'On' : 'Off') : null}
                fallback={defaults[f.key] ? 'On' : 'Off'}
              />
            ))}
          </div>
          {settings ? (
            <p className="-mt-2 px-5 pb-4 text-[12px] text-muted-foreground">
              Changed {settings.updatedBy ? `by ${settings.updatedBy}, ` : ''}
              {formatDate(settings.updatedAt)}
            </p>
          ) : null}
        </Card>

        {isHeadOffice ? (
          <Card title="Sites" meta={`${formatNumber(customer.sites.length)} ${pluralise(customer.sites.length, 'site')}`}>
            <div className="w-full overflow-x-auto border-t border-line">
              <table className="w-full min-w-[720px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-line">
                    <th scope="col" className={HEAD}>Name</th>
                    <th scope="col" className={HEAD}>Town</th>
                    <th scope="col" className={cn(HEAD, 'text-right')}>Machines</th>
                    <th scope="col" className={cn(HEAD, 'text-right')}>Pending</th>
                    <th scope="col" className={HEAD}>Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {customer.sites.map((s) => {
                    const stock = customerStockBadge(s.selfManaged);
                    return (
                      <tr key={s.vantageId} className="border-b border-line last:border-b-0">
                        <td className={cn(CELL, 'max-w-[320px]')}>
                          <Link href={customerHref(s.vantageId)} className="block truncate font-medium hover:text-brand hover:underline">
                            {s.name ?? `Customer ${s.vantageId}`}
                          </Link>
                          {s.reference ? <span className="font-mono text-[11px] text-muted-foreground">{s.reference}</span> : null}
                        </td>
                        <td className={CELL}>{s.town ?? '—'}</td>
                        <td className={cn(CELL, 'text-right tabular')}>{formatNumber(s.machines)}</td>
                        <td className={cn(CELL, 'text-right tabular')}>{formatNumber(s.pending)}</td>
                        <td className={CELL}>
                          {stock.tone === 'muted' ? (
                            <span className="text-muted-foreground">{stock.text}</span>
                          ) : (
                            <ToneBadge tone={stock.tone} dot={false} className="px-2 py-0.5 text-[12px]">
                              {stock.text}
                            </ToneBadge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        <Card
          title="Machines"
          meta={`${formatNumber(devices.visible.length)} ${pluralise(devices.visible.length, 'machine')}${
            isHeadOffice ? ' across all sites' : ''
          }`}
        >
          <DeviceTable
            rows={devices.visible}
            now={now}
            from="customers"
            back={path}
            emptyMessage="No linked DRMS devices for this customer."
            className="border-t border-line"
          />
          {devices.hidden.length > 0 ? (
            <details className="group border-t border-line">
              <summary className="flex cursor-pointer items-center gap-1.5 px-5 py-3 text-[13px] font-medium text-muted-foreground marker:content-none hover:text-foreground">
                <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
                Hidden ({formatNumber(devices.hidden.length)})
              </summary>
              <DeviceTable rows={devices.hidden} now={now} from="customers" back={path} className="border-t border-line" />
            </details>
          ) : null}
        </Card>

        <Card
          title={`Toner orders (last ${ORDER_MONTHS} months)`}
          meta={orders.length > 0 ? `${formatNumber(orders.length)} ${pluralise(orders.length, 'order')}` : null}
        >
          <OrderHistory
            orders={orders}
            lastByColour={NO_HEADLINE}
            isColour={anyColour}
            showHeadline={false}
            machines={machineOf}
            emptyMessage={`No toner orders for this customer’s machines in the last ${ORDER_MONTHS} months.`}
            className="border-t border-line"
          />
        </Card>

        <Card
          id="shelves"
          title="Shelves"
          meta={`${formatNumber(shelves.length)} ${pluralise(shelves.length, 'shelf', 'shelves')}`}
          action={
            <NewShelfDialog
              families={families.map((f) => ({ id: f.id, name: f.name, isColour: f.isColour, models: f.models }))}
              error={addError}
              customer={{ vantageId: id, name: customer.name, reference: customer.reference, deviceCount: ownMachines }}
              returnTo={path}
            />
          }
        >
          {strayShelfError ? (
            <p role="alert" className="mx-5 mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {strayShelfError}
            </p>
          ) : null}
          {shelves.length === 0 ? (
            <p className="border-t border-line px-5 py-10 text-center text-sm text-muted-foreground">
              No site stock shelves{isHeadOffice ? ' at this head office or its sites' : ' for this customer'}.
            </p>
          ) : (
            <div className="grid gap-4 border-t border-line px-5 py-4 lg:grid-cols-2">
              {shelves.map((shelf) => {
                const title = `${shelf.siteName} · ${shelf.familyName}`;
                return (
                  <div key={shelf.id} id={`shelf-${shelf.id}`} className="grid scroll-mt-6 content-start gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Link
                          href={`/site-stock/${shelf.id}`}
                          className="inline-flex min-w-0 items-center gap-1.5 text-[14px] font-medium hover:text-brand hover:underline"
                        >
                          <Boxes aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                          <span className="truncate">{title}</span>
                        </Link>
                        <span className="text-[12px] text-muted-foreground">
                          {formatNumber(shelf.machines)} {pluralise(shelf.machines, 'machine')}
                        </span>
                        {shelf.liveTopUp ? (
                          <ToneBadge tone="warn" dot={false} className="px-2 py-0.5 text-[11px]">
                            Top-up proposed
                          </ToneBadge>
                        ) : null}
                      </div>
                      <DeleteShelfDialog
                        shelfId={shelf.id}
                        name={title}
                        liveTopUp={shelf.liveTopUp}
                        error={shelfErrorIn(shelf.id, 'delete')}
                        returnTo={path}
                      />
                    </div>
                    <HoldingsForm
                      // Remounts from the saved values after a save; a refused save keeps what was entered.
                      key={JSON.stringify([shelf.holding, shelf.used])}
                      shelfId={shelf.id}
                      isColour={shelf.isColour}
                      holding={shelf.holding}
                      used={shelf.used}
                      error={shelfErrorIn(shelf.id, 'holdings')}
                      correctError={shelfErrorIn(shelf.id, 'correct')}
                      returnTo={path}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
