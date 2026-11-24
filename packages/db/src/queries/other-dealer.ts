import { regionOf, resolveOtherDealer, type OtherDealerFlag, type OtherDealerResolution } from '@mps/core';
import { sql } from 'drizzle-orm';
import type { Db } from '../client';
import { customerFlags, vantageCustomers } from '../schema';
import { headOfficeIdSql } from './customer-flags';
import { getPlannerSettings } from './pm-planner-settings';
import { SettingsError } from './settings';
import { audit } from './site-stock-actions';

/** Who services a site for PM: the resolved other dealer (null = us), where that came from, and the address region. */
export type OtherDealerInfo = OtherDealerResolution;

const OURS: OtherDealerInfo = { dealer: null, source: null, region: null };

/**
 * One load of every customer's postcode, county and head office (from `raw`), the other-dealer flags
 * and the planner settings, then a pure lookup per Vantage customer id. Unknown or null ids are ours.
 * The region rule uses the site's own address; head-office flags cover its sites.
 */
export async function loadDealerResolver(db: Db): Promise<(vantageCustomerId: number | null) => OtherDealerInfo> {
  const [customers, flags, settings] = await Promise.all([
    db
      .select({
        id: vantageCustomers.vantageId,
        postCode: sql<string | null>`${vantageCustomers.raw}->>'PostCode'`,
        county: sql<string | null>`${vantageCustomers.raw}->>'County'`,
        headOffice: headOfficeIdSql(),
      })
      .from(vantageCustomers),
    db
      .select({ id: customerFlags.vantageCustomerId, override: customerFlags.otherDealerOverride, name: customerFlags.otherDealerName })
      .from(customerFlags),
    getPlannerSettings(db),
  ]);
  const flagById = new Map<number, OtherDealerFlag>();
  for (const f of flags) {
    if (f.override === 'dealer' || f.override === 'ours') flagById.set(f.id, { override: f.override, name: f.name });
  }
  const byId = new Map<number, OtherDealerInfo>();
  for (const c of customers) {
    byId.set(
      c.id,
      resolveOtherDealer({
        own: flagById.get(c.id) ?? null,
        headOffice: c.headOffice === null ? null : (flagById.get(c.headOffice) ?? null),
        region: regionOf({ postCode: c.postCode, county: c.county }),
        regionDealers: settings.regionDealers,
      }),
    );
  }
  return (id) => (id === null ? OURS : (byId.get(id) ?? OURS));
}

/**
 * Sets a site's manual other-dealer state: `dealer` (named), `ours` (undo the region rule) or `default`
 * (clear both columns so the head office / region rule decides). Upserts `customer_flags` without
 * touching self-managed. PM only: nothing else reads these columns.
 */
export async function setOtherDealer(
  db: Db,
  a: { vantageCustomerId: number; mode: 'default' | 'ours' | 'dealer'; name?: string | null; userId: number; now?: Date },
): Promise<void> {
  const now = a.now ?? new Date();
  let name: string | null = null;
  if (a.mode === 'dealer') {
    name = a.name?.trim() || null;
    if (name === null) throw new SettingsError('Enter the dealer’s name.', 'invalid_other_dealer');
    if (name.length > 60) throw new SettingsError('The dealer name must be at most 60 characters.', 'invalid_other_dealer');
  }
  const override = a.mode === 'default' ? null : a.mode;
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t
      .insert(customerFlags)
      .values({ vantageCustomerId: a.vantageCustomerId, otherDealerOverride: override, otherDealerName: name, updatedBy: a.userId, updatedAt: now })
      .onConflictDoUpdate({
        target: customerFlags.vantageCustomerId,
        set: { otherDealerOverride: override, otherDealerName: name, updatedBy: a.userId, updatedAt: now },
      });
    await audit(t, {
      userId: a.userId,
      action: 'customer.other_dealer.set',
      entity: 'customer',
      ids: [a.vantageCustomerId],
      details: { mode: a.mode, name },
      now,
    });
  });
}
