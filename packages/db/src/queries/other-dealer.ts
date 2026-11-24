import { regionOf, resolveOtherDealer, type OtherDealerFlag, type OtherDealerResolution } from '@mps/core';
import { and, inArray, isNull, or, eq, sql } from 'drizzle-orm';
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

/** What the *PM by* control (customer page, device page) needs for one site. */
export interface OtherDealerControlData {
  customerName: string;
  /** The site's own manual state; null = none (head office / region decide). */
  ownOverride: 'ours' | 'dealer' | null;
  ownDealerName: string | null;
  /** Who services it now. */
  effective: OtherDealerInfo;
  /** What "Default" gives: the head office flag, else the region rule. */
  defaultInfo: OtherDealerInfo;
  /** The region dealers from the planner settings, for the dealer-name suggestions. */
  suggestions: string[];
  isHeadOffice: boolean;
}

/**
 * The *PM by* control's props for one Vantage customer, without loading every site (the customer
 * page's `getCustomer` does that). Null when the customer does not exist, or is deleted in Vantage
 * and has no `customer_flags` row (as `getCustomer`).
 */
export async function getOtherDealerControl(db: Db, vantageCustomerId: number): Promise<OtherDealerControlData | null> {
  const [c] = await db
    .select({
      name: vantageCustomers.name,
      postCode: sql<string | null>`nullif(btrim(${vantageCustomers.raw}->>'PostCode'), '')`,
      county: sql<string | null>`${vantageCustomers.raw}->>'County'`,
      headOffice: headOfficeIdSql(),
    })
    .from(vantageCustomers)
    .where(
      and(
        eq(vantageCustomers.vantageId, vantageCustomerId),
        or(
          isNull(vantageCustomers.deletedDate),
          sql`exists (select 1 from ${customerFlags} where ${customerFlags.vantageCustomerId} = ${vantageCustomerId})`,
        ),
      ),
    );
  if (!c) return null;
  const [flagRows, [sites], settings] = await Promise.all([
    db
      .select({ id: customerFlags.vantageCustomerId, override: customerFlags.otherDealerOverride, name: customerFlags.otherDealerName })
      .from(customerFlags)
      .where(inArray(customerFlags.vantageCustomerId, c.headOffice === null ? [vantageCustomerId] : [vantageCustomerId, c.headOffice])),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(vantageCustomers)
      .where(and(isNull(vantageCustomers.deletedDate), sql`${headOfficeIdSql()} = ${vantageCustomerId}`)),
    getPlannerSettings(db),
  ]);
  const flagOf = (id: number | null): OtherDealerFlag | null => {
    const f = flagRows.find((r) => r.id === id);
    return f && (f.override === 'dealer' || f.override === 'ours') ? { override: f.override, name: f.name } : null;
  };
  const own = flagOf(vantageCustomerId);
  const region = regionOf({ postCode: c.postCode, county: c.county });
  const common = { region, regionDealers: settings.regionDealers };
  return {
    customerName: c.name ?? `Customer ${vantageCustomerId}`,
    ownOverride: own?.override ?? null,
    ownDealerName: own?.override === 'dealer' ? own.name : null,
    effective: resolveOtherDealer({ own, headOffice: flagOf(c.headOffice), ...common }),
    defaultInfo: resolveOtherDealer({ own: null, headOffice: flagOf(c.headOffice), ...common }),
    suggestions: [...new Set(Object.values(settings.regionDealers).filter((d): d is string => !!d))],
    isHeadOffice: (sites?.n ?? 0) > 0,
  };
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
