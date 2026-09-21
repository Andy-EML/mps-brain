import { getDefaultSettings, listCustomerSettings, type CustomerSettingsRow, type DefaultSettings } from '@mps/db/queries';
import { cn } from 'cn';
import { Breadcrumb } from '@/components/breadcrumb';
import { AddCustomerOverrideDialog, ResetCustomerDialog } from '@/components/customer-override-dialogs';
import { PageHeader } from '@/components/page-header';
import { SettingsDialog, type SettingsField, type SettingsHint } from '@/components/settings-dialog';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatDate, formatNumber, pluralise } from '@/lib/format';
import { settingsErrorMessage } from '@/lib/settings-form';
import { updateCustomerAction, updateDefaultsAction } from './actions';

export const metadata = { title: 'Replenishment settings · MPS Dashboard' };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const FIELDS: SettingsField[] = ['black', 'cyan', 'magenta', 'yellow', 'autoReplenish', 'alertsEnabled'];

const THRESHOLDS = [
  { field: 'black', key: 'thresholdBlack', label: 'Black' },
  { field: 'cyan', key: 'thresholdCyan', label: 'Cyan' },
  { field: 'magenta', key: 'thresholdMagenta', label: 'Magenta' },
  { field: 'yellow', key: 'thresholdYellow', label: 'Yellow' },
] as const;

const FLAGS = [
  { field: 'autoReplenish', key: 'autoReplenish', label: 'Auto-replenish' },
  { field: 'alertsEnabled', key: 'alertsEnabled', label: 'No-meter-reading alerts' },
] as const;

/** The defaults as dialog hints: `Now 15% · default`. */
function defaultHints(d: DefaultSettings): Partial<Record<SettingsField, SettingsHint>> {
  const hints: Partial<Record<SettingsField, SettingsHint>> = {};
  for (const t of THRESHOLDS) hints[t.field] = { value: d[t.key], origin: 'default' };
  for (const f of FLAGS) hints[f.field] = { value: d[f.key], origin: 'default' };
  return hints;
}

/** What a customer's devices get now, field by field: the override, or the default beneath it. */
function customerHints(row: CustomerSettingsRow, d: DefaultSettings): Partial<Record<SettingsField, SettingsHint>> {
  const hints: Partial<Record<SettingsField, SettingsHint>> = {};
  for (const { field, key } of [...THRESHOLDS, ...FLAGS]) {
    const own = row[key];
    hints[field] = own === null ? { value: d[key], origin: 'default' } : { value: own, origin: 'this customer' };
  }
  return hints;
}

function onOff(value: boolean): string {
  return value ? 'On' : 'Off';
}

function changedBy(by: string | null, at: Date): string {
  return by ? `${by}, ${formatDate(at)}` : formatDate(at);
}

const HEAD = 'px-4 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase whitespace-nowrap';
const CELL = 'px-4 py-3 align-middle text-[13px]';

/**
 * `/settings/replenishment`, for every signed-in user: the default thresholds and flags, and the
 * customer overrides that sit between them and a device's own settings.
 *
 * `?settingsError=<code>&settingsFor=<dialog>` comes back from the actions; the sentence is looked
 * up here (a crafted link cannot put arbitrary text on the page) and shown inside the dialog it
 * belongs to. One with no dialog to go to (a reset of a customer that has gone) shows above the
 * cards instead.
 */
export default async function ReplenishmentSettingsPage({ searchParams }: PageProps<'/settings/replenishment'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const params = await searchParams;

  const errorCode = first(params.settingsError);
  const error = errorCode ? settingsErrorMessage(errorCode) : null;
  const errorFor = error ? (first(params.settingsFor) ?? '') : '';

  const db = getDb();
  const [defaults, customers] = await Promise.all([getDefaultSettings(db), listCustomerSettings(db)]);

  const dialogs = new Set(['default', 'add', ...customers.map((c) => `customer-${c.vantageCustomerId}`)]);
  const pageError = error && !dialogs.has(errorFor) ? error : null;
  const errorIn = (dialog: string) => (errorFor === dialog ? error : null);

  return (
    <>
      <Breadcrumb className="mb-3" items={[{ label: 'Fleet overview', href: '/' }, { label: 'Replenishment settings' }]} />

      <PageHeader
        title="Replenishment settings"
        subtitle="A device uses its own setting first, then its customer's, then these defaults."
      />

      {pageError ? (
        <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-5 py-3.5 text-sm text-destructive">
          {pageError}
        </p>
      ) : null}

      <section className="rounded-xl border border-line bg-card px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-medium">Defaults</h2>
          <SettingsDialog
            title="Default replenishment settings"
            fields={FIELDS}
            initial={defaultHints(defaults)}
            allowInherit={false}
            isColour
            action={updateDefaultsAction}
            error={errorIn('default')}
          />
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          {THRESHOLDS.map((t) => (
            <DefaultValue key={t.key} label={`${t.label} threshold`} value={`${defaults[t.key]}%`} />
          ))}
          {FLAGS.map((f) => (
            <DefaultValue key={f.key} label={f.label} value={onOff(defaults[f.key])} />
          ))}
        </dl>

        <p className="mt-4 text-[12px] text-muted-foreground">
          {defaults.lastChange
            ? `Last changed by ${changedBy(defaults.lastChange.by ?? 'an unknown user', defaults.lastChange.at)}.`
            : 'Not changed since setup.'}{' '}
          A cartridge counts as low when its level is below the threshold. Mono devices only use the
          black threshold.
        </p>
      </section>

      <section className="mt-5 rounded-xl border border-line bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
          <div>
            <h2 className="text-[15px] font-medium">Customer overrides</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {customers.length === 0
                ? 'None yet — every customer uses the defaults.'
                : `${formatNumber(customers.length)} ${pluralise(customers.length, 'customer')}. A blank cell uses the default.`}
            </p>
          </div>
          <AddCustomerOverrideDialog
            initial={defaultHints(defaults)}
            existingIds={customers.map((c) => c.vantageCustomerId)}
            error={errorIn('add')}
          />
        </div>

        {customers.length > 0 ? (
          <div className="w-full overflow-x-auto border-t border-line">
            <table className="w-full min-w-[960px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={HEAD}>Customer</th>
                  <th scope="col" className={HEAD}>Reference</th>
                  <th scope="col" className={cn(HEAD, 'text-right')}>Devices</th>
                  {THRESHOLDS.map((t) => (
                    <th key={t.key} scope="col" className={cn(HEAD, 'text-right')}>
                      <abbr title={`${t.label} threshold`} className="no-underline">
                        {t.label.charAt(0)}
                      </abbr>
                    </th>
                  ))}
                  <th scope="col" className={HEAD}>Auto-replenish</th>
                  <th scope="col" className={HEAD}>Alerts</th>
                  <th scope="col" className={HEAD}>Changed</th>
                  <th scope="col" className={cn(HEAD, 'text-right')}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {customers.map((row) => {
                  const name = row.customerName ?? `Vantage customer ${row.vantageCustomerId}`;
                  const dialog = `customer-${row.vantageCustomerId}`;
                  return (
                    <tr
                      key={row.vantageCustomerId}
                      id={dialog}
                      className="scroll-mt-6 border-b border-line last:border-b-0 target:bg-brand-soft/40"
                    >
                      <td className={cn(CELL, 'font-medium')}>{name}</td>
                      <td className={cn(CELL, 'font-mono text-[12px] text-muted-foreground')}>{row.reference ?? ''}</td>
                      <td className={cn(CELL, 'text-right tabular')}>{formatNumber(row.deviceCount)}</td>
                      {THRESHOLDS.map((t) => (
                        <td key={t.key} className={cn(CELL, 'text-right tabular')}>
                          {row[t.key] === null ? <Inherited /> : `${row[t.key]}%`}
                        </td>
                      ))}
                      {FLAGS.map((f) => (
                        <td key={f.key} className={CELL}>
                          {row[f.key] === null ? <Inherited /> : onOff(row[f.key]!)}
                        </td>
                      ))}
                      <td className={cn(CELL, 'whitespace-nowrap text-muted-foreground')}>
                        {changedBy(row.updatedBy, row.updatedAt)}
                      </td>
                      <td className={cn(CELL, 'text-right')}>
                        <div className="flex items-center justify-end gap-2">
                          <SettingsDialog
                            title={`Replenishment settings for ${name}`}
                            description="Applies to every device of this customer that has no setting of its own. Leave a field on Keep to leave it as it is; Inherit uses the default again."
                            fields={FIELDS}
                            initial={customerHints(row, defaults)}
                            allowInherit
                            isColour
                            action={updateCustomerAction}
                            hidden={{ vantageCustomerId: String(row.vantageCustomerId) }}
                            error={errorIn(dialog)}
                          />
                          <ResetCustomerDialog
                            vantageCustomerId={row.vantageCustomerId}
                            customerName={name}
                            deviceCount={row.deviceCount}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  );
}

function DefaultValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-medium tabular">{value}</dd>
    </div>
  );
}

/** A blank cell that still says what it means to a screen reader. */
function Inherited() {
  return <span className="sr-only">Default</span>;
}
