import { REPLENISH_COLOURS, deviceDisplayName, type ReplenishColour, type ShelfConsumableCounts } from '@mps/core';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import {
  cartridgeFamilies,
  cartridgeFamilyModels,
  deviceLinks,
  drmsEquipment,
  replenishmentProposals,
  siteStockEvents,
  siteStockShelves,
  vantageCustomers,
  vantageEquipment,
} from '../schema';
import { effectiveSettingsSubquery } from './settings';
import { drmsEquipmentName } from './shared';

const MONITORED = sql`upper(${drmsEquipment.status}) in ('REGISTERED','DISCOVERED') and ${drmsEquipment.missingSince} is null`;

/**
 * One row per monitored device on a shelf: its active link points at the shelf's customer and its
 * model belongs to the shelf's family. THE place shelf membership is expressed — the evaluator,
 * the shelf counter and the pages all read this, so they cannot disagree.
 */
export function shelfDevicesSubquery(db: Db) {
  return db
    .select({
      shelfId: siteStockShelves.id,
      drmsId: drmsEquipment.drmsId,
      vantageEquipmentId: deviceLinks.vantageEquipmentId,
      vantageCustomerId: siteStockShelves.vantageCustomerId,
      familyId: siteStockShelves.familyId,
    })
    .from(siteStockShelves)
    .innerJoin(cartridgeFamilyModels, eq(cartridgeFamilyModels.familyId, siteStockShelves.familyId))
    .innerJoin(drmsEquipment, eq(drmsEquipment.modelName, cartridgeFamilyModels.model))
    .innerJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
    .innerJoin(
      vantageEquipment,
      and(eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId), eq(vantageEquipment.vantageCustomerId, siteStockShelves.vantageCustomerId)),
    )
    .where(MONITORED)
    .as('shelf_devices');
}

export interface ShelfSummary {
  id: number;
  vantageCustomerId: number;
  siteName: string;
  customerReference: string | null;
  postcode: string | null;
  headOfficeName: string | null;
  familyId: number;
  familyName: string;
  isColour: boolean;
  machines: number;
  holding: ShelfConsumableCounts;
  used: ShelfConsumableCounts;
  liveTopUp: boolean;
  autoOffDevices: number;
}

const cap = (c: ReplenishColour) => (c.charAt(0).toUpperCase() + c.slice(1)) as Capitalize<ReplenishColour>;

function counts(prefix: 'holding' | 'used', r: object): ShelfConsumableCounts {
  const out = {} as ShelfConsumableCounts;
  for (const c of REPLENISH_COLOURS) out[c] = (r as Record<string, number>)[`${prefix}${cap(c)}`] ?? 0;
  return out;
}

/** Head office id sits in the customer JSON as a number or string; anything else is no head office. */
const headOfficeId = sql<number | null>`case when ${vantageCustomers.raw}->>'HeadOfficeId' ~ '^[0-9]{1,9}$' then (${vantageCustomers.raw}->>'HeadOfficeId')::int end`;

async function summaries(db: Db, shelfIds?: number[]): Promise<ShelfSummary[]> {
  const rows = await db
    .select({
      id: siteStockShelves.id,
      vantageCustomerId: siteStockShelves.vantageCustomerId,
      siteName: vantageCustomers.name,
      customerReference: vantageCustomers.reference,
      postcode: sql<string | null>`${vantageCustomers.raw}->>'PostCode'`,
      headOfficeId,
      familyId: siteStockShelves.familyId,
      familyName: cartridgeFamilies.name,
      isColour: cartridgeFamilies.isColour,
      holdingBlack: siteStockShelves.holdingBlack,
      holdingCyan: siteStockShelves.holdingCyan,
      holdingMagenta: siteStockShelves.holdingMagenta,
      holdingYellow: siteStockShelves.holdingYellow,
      holdingWaste: siteStockShelves.holdingWaste,
      usedBlack: siteStockShelves.usedBlack,
      usedCyan: siteStockShelves.usedCyan,
      usedMagenta: siteStockShelves.usedMagenta,
      usedYellow: siteStockShelves.usedYellow,
      usedWaste: siteStockShelves.usedWaste,
    })
    .from(siteStockShelves)
    .innerJoin(cartridgeFamilies, eq(cartridgeFamilies.id, siteStockShelves.familyId))
    .leftJoin(vantageCustomers, eq(vantageCustomers.vantageId, siteStockShelves.vantageCustomerId))
    .where(shelfIds === undefined ? undefined : inArray(siteStockShelves.id, shelfIds));
  if (rows.length === 0) return [];

  const sd = shelfDevicesSubquery(db);
  const eff = effectiveSettingsSubquery(db);
  const members = await db
    .select({
      shelfId: sd.shelfId,
      machines: count(),
      autoOff: sql<number>`count(*) filter (where ${eff.autoReplenish} = false)`.mapWith(Number),
    })
    .from(sd)
    .leftJoin(eff, eq(eff.drmsId, sd.drmsId))
    .groupBy(sd.shelfId);
  const memberByShelf = new Map(members.map((m) => [m.shelfId, m]));

  const live = await db
    .selectDistinct({ shelfId: replenishmentProposals.shelfId })
    .from(replenishmentProposals)
    .where(inArray(replenishmentProposals.status, ['pending', 'approved']));
  const liveShelves = new Set(live.map((l) => l.shelfId));

  const hoIds = [...new Set(rows.map((r) => r.headOfficeId).filter((x): x is number => x !== null))];
  const hos = hoIds.length
    ? await db
        .select({ id: vantageCustomers.vantageId, name: vantageCustomers.name })
        .from(vantageCustomers)
        .where(inArray(vantageCustomers.vantageId, hoIds))
    : [];
  const hoName = new Map(hos.map((h) => [h.id, h.name]));

  return rows.map((r) => ({
    id: r.id,
    vantageCustomerId: r.vantageCustomerId,
    siteName: r.siteName ?? `Customer ${r.vantageCustomerId}`,
    customerReference: r.customerReference,
    postcode: r.postcode,
    headOfficeName: r.headOfficeId !== null && r.headOfficeId !== r.vantageCustomerId ? (hoName.get(r.headOfficeId) ?? null) : null,
    familyId: r.familyId,
    familyName: r.familyName,
    isColour: r.isColour,
    machines: memberByShelf.get(r.id)?.machines ?? 0,
    holding: counts('holding', r),
    used: counts('used', r),
    liveTopUp: liveShelves.has(r.id),
    autoOffDevices: memberByShelf.get(r.id)?.autoOff ?? 0,
  }));
}

/** Summaries for just these shelves (e.g. the ones a queue's proposals point at). */
export function listShelfSummariesByIds(db: Db, ids: number[]): Promise<ShelfSummary[]> {
  return ids.length === 0 ? Promise.resolve([]) : summaries(db, ids);
}

export async function listShelves(db: Db, args: { search?: string } = {}): Promise<ShelfSummary[]> {
  let all = await summaries(db);
  const q = args.search?.trim().toLowerCase();
  if (q) {
    all = all.filter((s) => [s.siteName, s.customerReference, s.postcode, s.familyName].some((v) => v !== null && v.toLowerCase().includes(q)));
  }
  return all.sort(
    (a, b) => Number(b.liveTopUp) - Number(a.liveTopUp) || a.siteName.localeCompare(b.siteName) || a.familyName.localeCompare(b.familyName),
  );
}

export interface ShelfDetail extends ShelfSummary {
  devices: { drmsId: string; displayName: string; model: string | null; serial: string | null }[];
  events: { at: Date; drmsId: string | null; displayName: string | null; colour: ReplenishColour | null; counted: boolean; reason: string }[];
}

type NamedDevice = { drmsId: string; equipmentName: string | null; customerName: string | null; model: string | null; serial: string | null };
const nameOf = (d: NamedDevice) =>
  deviceDisplayName({ equipmentName: d.equipmentName, customerName: d.customerName, model: d.model, serial: d.serial, drmsId: d.drmsId });

export async function getShelf(db: Db, id: number): Promise<ShelfDetail | null> {
  const [summary] = await summaries(db, [id]);
  if (!summary) return null;
  const sd = shelfDevicesSubquery(db);
  const devs = await db
    .select({
      drmsId: drmsEquipment.drmsId,
      equipmentName: drmsEquipmentName(),
      customerName: drmsEquipment.customerName,
      model: drmsEquipment.modelName,
      serial: drmsEquipment.serial,
    })
    .from(sd)
    .innerJoin(drmsEquipment, eq(drmsEquipment.drmsId, sd.drmsId))
    .where(eq(sd.shelfId, id))
    .orderBy(asc(drmsEquipment.drmsId));
  const ev = await db
    .select({
      at: siteStockEvents.receivedAt,
      drmsId: siteStockEvents.drmsEquipmentId,
      equipmentName: drmsEquipmentName(),
      customerName: drmsEquipment.customerName,
      model: drmsEquipment.modelName,
      serial: drmsEquipment.serial,
      colour: siteStockEvents.colour,
      counted: siteStockEvents.counted,
      reason: siteStockEvents.reason,
    })
    .from(siteStockEvents)
    .leftJoin(drmsEquipment, eq(drmsEquipment.drmsId, siteStockEvents.drmsEquipmentId))
    .where(eq(siteStockEvents.shelfId, id))
    .orderBy(desc(siteStockEvents.receivedAt), desc(siteStockEvents.id))
    .limit(100);
  return {
    ...summary,
    devices: devs.map((d) => ({ drmsId: d.drmsId, displayName: nameOf(d), model: d.model, serial: d.serial })),
    events: ev.map((e) => ({
      at: e.at,
      drmsId: e.drmsId,
      displayName: e.drmsId ? nameOf({ ...e, drmsId: e.drmsId }) : null,
      colour: e.colour,
      counted: e.counted,
      reason: e.reason,
    })),
  };
}

export async function listShelfForDevice(db: Db, drmsId: string): Promise<{ shelfId: number; siteName: string; familyName: string } | null> {
  const sd = shelfDevicesSubquery(db);
  const [row] = await db
    .select({ shelfId: sd.shelfId, siteName: vantageCustomers.name, customerId: sd.vantageCustomerId, familyName: cartridgeFamilies.name })
    .from(sd)
    .innerJoin(cartridgeFamilies, eq(cartridgeFamilies.id, sd.familyId))
    .leftJoin(vantageCustomers, eq(vantageCustomers.vantageId, sd.vantageCustomerId))
    .where(eq(sd.drmsId, drmsId))
    .limit(1);
  return row ? { shelfId: row.shelfId, siteName: row.siteName ?? `Customer ${row.customerId}`, familyName: row.familyName } : null;
}

export interface FamilySummary {
  id: number;
  name: string;
  isColour: boolean;
  models: string[];
  ratedYield: Partial<Record<ReplenishColour, number>>;
  notes: string | null;
  shelves: number;
}

export async function listFamilies(db: Db): Promise<FamilySummary[]> {
  const fams = await db.select().from(cartridgeFamilies).orderBy(asc(cartridgeFamilies.name));
  const models = await db.select().from(cartridgeFamilyModels).orderBy(asc(cartridgeFamilyModels.model));
  const shelfCounts = await db
    .select({ familyId: siteStockShelves.familyId, n: count() })
    .from(siteStockShelves)
    .groupBy(siteStockShelves.familyId);
  const shelfBy = new Map(shelfCounts.map((s) => [s.familyId, s.n]));
  return fams.map((f) => {
    const ratedYield: Partial<Record<ReplenishColour, number>> = {};
    for (const c of REPLENISH_COLOURS) {
      const v = f[`ratedYield${cap(c)}`];
      if (v !== null) ratedYield[c] = v;
    }
    return {
      id: f.id,
      name: f.name,
      isColour: f.isColour,
      models: models.filter((m) => m.familyId === f.id).map((m) => m.model),
      ratedYield,
      notes: f.notes,
      shelves: shelfBy.get(f.id) ?? 0,
    };
  });
}

/** Monitored, linked devices whose model is in no family, grouped by model. */
export async function listUnmappedModels(db: Db): Promise<{ model: string; devices: number }[]> {
  const rows = await db
    .select({ model: drmsEquipment.modelName, devices: count() })
    .from(drmsEquipment)
    .innerJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
    .leftJoin(cartridgeFamilyModels, eq(cartridgeFamilyModels.model, drmsEquipment.modelName))
    .where(and(MONITORED, sql`${drmsEquipment.modelName} is not null`, isNull(cartridgeFamilyModels.model)))
    .groupBy(drmsEquipment.modelName)
    .orderBy(asc(drmsEquipment.modelName));
  return rows.map((r) => ({ model: r.model!, devices: r.devices }));
}

/**
 * One row per (site, family) in the fleet: linked monitored devices with a family, shelf values
 * or zeros. Column order is `SITE_STOCK_CSV_HEADERS`, so the file re-imports as it was exported.
 */
export async function listSiteStockExportRows(db: Db): Promise<(string | number | null)[][]> {
  const pairs = await db
    .select({
      customerId: vantageEquipment.vantageCustomerId,
      familyId: cartridgeFamilyModels.familyId,
      machines: sql<number>`count(distinct ${drmsEquipment.drmsId})`.mapWith(Number),
    })
    .from(drmsEquipment)
    .innerJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
    .innerJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .innerJoin(cartridgeFamilyModels, eq(cartridgeFamilyModels.model, drmsEquipment.modelName))
    .where(and(MONITORED, sql`${vantageEquipment.vantageCustomerId} is not null`))
    .groupBy(vantageEquipment.vantageCustomerId, cartridgeFamilyModels.familyId);
  if (pairs.length === 0) return [];
  const fams = new Map((await db.select({ id: cartridgeFamilies.id, name: cartridgeFamilies.name }).from(cartridgeFamilies)).map((f) => [f.id, f.name]));
  const custs = new Map(
    (
      await db
        .select({
          id: vantageCustomers.vantageId,
          name: vantageCustomers.name,
          reference: vantageCustomers.reference,
          postcode: sql<string | null>`${vantageCustomers.raw}->>'PostCode'`,
        })
        .from(vantageCustomers)
    ).map((c) => [c.id, c]),
  );
  const shelves = await db.select().from(siteStockShelves);
  const shelfBy = new Map(shelves.map((s) => [`${s.vantageCustomerId}:${s.familyId}`, s]));

  const out = pairs.map((p) => {
    const c = custs.get(p.customerId!);
    const s = shelfBy.get(`${p.customerId}:${p.familyId}`);
    const h = s ? counts('holding', s) : null;
    const u = s ? counts('used', s) : null;
    const site = c?.name ?? `Customer ${p.customerId}`;
    const fam = fams.get(p.familyId) ?? '';
    const row: (string | number | null)[] = [
      p.customerId!,
      site,
      c?.reference ?? null,
      c?.postcode ?? null,
      fam,
      p.machines,
      ...REPLENISH_COLOURS.map((k) => h?.[k] ?? 0),
      ...REPLENISH_COLOURS.map((k) => u?.[k] ?? 0),
    ];
    return { site, fam, row };
  });
  return out.sort((a, b) => a.site.localeCompare(b.site) || a.fam.localeCompare(b.fam)).map((o) => o.row);
}
