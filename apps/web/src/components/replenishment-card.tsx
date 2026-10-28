import Link from 'next/link';
import type { ReplenishColour } from '@mps/core';
import type { EffectiveSettings, QueueOrder, QueueProposal, SettingSource } from '@mps/db/queries';
import { updateDeviceSettingsAction } from '@/app/(app)/devices/[id]/actions';
import {
  colourLabel,
  orderStatusLabel,
  orderStatusTone,
  proposalStatusLink,
  settingOrigin,
  triggerLabel,
} from '@/components/replenishment';
import { ReviewForm } from '@/components/replenishment-queue';
import { SettingsDialog, type SettingsField, type SettingsHint } from '@/components/settings-dialog';
import { coveredColoursText } from '@/components/shelf';
import { ToneBadge } from '@/components/tone-badge';
import { formatDate } from '@/lib/format';

export interface ReplenishmentCardProps {
  drmsId: string;
  /** From `drms_equipment.is_colour`: a mono device has no cyan/magenta/yellow rows. */
  isColour: boolean;
  settings: EffectiveSettings;
  /** This device's live proposals (pending or approved) and its latest MPS orders. */
  proposals: QueueProposal[];
  orders: QueueOrder[];
  /** No current Vantage link: pending proposals can be rejected but not approved. */
  unlinked: boolean;
  /** A sentence for `?settingsError=` from the Edit dialog's action. */
  error?: string | null;
  /** A sentence for `?error=` from an approve/reject made on this card. */
  decisionError?: string | null;
  /** The site stock shelf this device draws from, and the consumables it holds (none: no note). */
  siteStock?: { shelfId: number; covered: ReplenishColour[] } | null;
}

const COLOURS = ['black', 'cyan', 'magenta', 'yellow'] as const;

/** Where an order sits on `/orders`: the In progress tab until it has reached Vantage. */
function orderHref(order: QueueOrder): string {
  return order.status === 'submitted' ? '/orders?tab=ordered' : '/orders?tab=in-progress';
}

/**
 * The device page's *Replenishment* card: the effective threshold per cartridge and the two
 * flags, each with where it came from (default, customer setting, or this device — with who set
 * it and when), an Edit dialog for the device-level overrides, and this device's live proposals
 * and MPS orders. Pending proposals can be approved or rejected right here, with the queue's own
 * form; approved ones link to where they sit on `/orders`.
 */
export function ReplenishmentCard({
  drmsId,
  isColour,
  settings,
  proposals,
  orders,
  unlinked,
  error,
  decisionError,
  siteStock,
}: ReplenishmentCardProps) {
  const pending = proposals.filter((p) => p.status === 'pending');
  const decided = proposals.filter((p) => p.status !== 'pending');
  const colours = isColour ? COLOURS : (['black'] as const);
  // A value that comes from the customer links to that customer's row on the settings page.
  const customerHref =
    settings.vantageCustomerId === null ? undefined : `/settings/replenishment#customer-${settings.vantageCustomerId}`;
  const hrefFor = (source: SettingSource) => (source === 'customer' ? customerHref : undefined);

  const initial: Partial<Record<SettingsField, SettingsHint>> = {
    autoReplenish: { value: settings.autoReplenish.value, origin: settingOrigin(settings.autoReplenish.source, settings) },
    alertsEnabled: { value: settings.alertsEnabled.value, origin: settingOrigin(settings.alertsEnabled.source, settings) },
  };
  for (const c of colours) {
    initial[c] = { value: settings.thresholds[c].value, origin: settingOrigin(settings.thresholds[c].source, settings) };
  }

  return (
    <section className="rounded-xl border border-line bg-card px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium">Replenishment</h2>
        <SettingsDialog
          title="Replenishment settings for this device"
          fields={[...colours, 'autoReplenish', 'alertsEnabled']}
          initial={initial}
          allowInherit
          isColour={isColour}
          action={updateDeviceSettingsAction}
          hidden={{ drmsId }}
          error={error}
        />
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-critical/5 px-3 py-2 text-[13px] text-critical">
          {error}
        </p>
      ) : null}

      {siteStock && siteStock.covered.length > 0 ? (
        <p className="mt-3 rounded-lg bg-brand-soft/60 px-3 py-2 text-[13px]">
          Normal proposals off for {coveredColoursText(siteStock.covered)} —{' '}
          <Link href={`/site-stock/${siteStock.shelfId}`} className="font-medium text-brand hover:underline">
            on a site stock shelf
          </Link>
          .
        </p>
      ) : null}

      <dl className="mt-3">
        {colours.map((c) => (
          <SettingRow
            key={c}
            label={`${colourLabel(c)} threshold`}
            value={`${settings.thresholds[c].value}%`}
            origin={initial[c]?.origin}
            originHref={hrefFor(settings.thresholds[c].source)}
          />
        ))}
        <SettingRow
          label="Auto-replenish"
          value={settings.autoReplenish.value ? 'On' : 'Off'}
          origin={initial.autoReplenish?.origin}
          originHref={hrefFor(settings.autoReplenish.source)}
        />
        <SettingRow
          label="No-meter-reading alerts"
          value={settings.alertsEnabled.value ? 'On' : 'Off'}
          origin={initial.alertsEnabled?.origin}
          originHref={hrefFor(settings.alertsEnabled.source)}
        />
      </dl>

      {decisionError ? (
        <p role="alert" className="mt-3 rounded-lg bg-critical/5 px-3 py-2 text-[13px] text-critical">
          {decisionError}
        </p>
      ) : null}

      {proposals.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-[13px] font-medium">Toner proposals</h3>
          {pending.length > 0 ? (
            <div className="mt-2">
              <ReviewForm drmsId={drmsId} proposals={pending} unlinked={unlinked} back="device" compact />
            </div>
          ) : null}
          {decided.length > 0 ? (
            <ul className="mt-1">
              {decided.map((p) => {
                const status = proposalStatusLink(p);
                return (
                  <li key={p.id} className="border-b border-line/70 py-2 last:border-0">
                    <Link href={status.href} className="block text-[13px] hover:underline">
                      <span className="font-medium">{colourLabel(p.colour)}</span>
                      <span className="text-muted-foreground"> · {triggerLabel(p)} · </span>
                      <span className="text-brand">{status.text}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {orders.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-[13px] font-medium">MPS orders</h3>
          <ul className="mt-1">
            {orders.map((order) => (
              <li key={order.id} className="border-b border-line/70 py-2 last:border-0">
                <Link href={orderHref(order)} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] hover:underline">
                  <ToneBadge tone={orderStatusTone(order.status)} dot={false} className="px-2 py-0.5 text-[12px]">
                    {orderStatusLabel(order.status)}
                  </ToneBadge>
                  {order.isOnHold ? (
                    <ToneBadge tone="warn" dot={false} className="px-2 py-0.5 text-[12px]">
                      On hold
                    </ToneBadge>
                  ) : null}
                  <span className="font-mono text-[12px]">{order.vantageReference ?? '—'}</span>
                  <span className="ml-auto text-muted-foreground">{formatDate(order.submittedAt ?? order.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {proposals.length === 0 && orders.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted-foreground">No toner proposals or MPS orders for this device.</p>
      ) : null}
    </section>
  );
}

/** A label/value line with the value's origin in muted text beneath it, a link when it has somewhere to go. */
function SettingRow({ label, value, origin, originHref }: { label: string; value: string; origin?: string; originHref?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/70 py-2 last:border-0">
      <dt className="shrink-0 text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">
        <span className="text-[13px] font-medium tabular">{value}</span>
        {origin && originHref ? (
          <Link href={originHref} className="block text-[12px] text-muted-foreground hover:text-brand hover:underline">
            {origin}
          </Link>
        ) : origin ? (
          <span className="block text-[12px] text-muted-foreground">{origin}</span>
        ) : null}
      </dd>
    </div>
  );
}
