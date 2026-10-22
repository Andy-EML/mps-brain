import { MAX_HOLDING, REPLENISH_COLOURS, type ImportRow, type ReplenishColour, type ShelfConsumableCounts } from '@mps/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client';
import {
  auditLog,
  cartridgeFamilies,
  cartridgeFamilyModels,
  replenishmentProposals,
  replenishmentSettings,
  siteStockShelves,
  vantageCustomers,
} from '../schema';
import { updateDeviceSettings } from './settings';
import { shelfDevicesSubquery } from './site-stock';

/**
 * Writes for cartridge families and customer-site shelves, and the CSV import. Each is one
 * transaction with one `audit_log` row; failures throw a `SiteStockError` and write nothing.
 * `userId` always comes from the session, never the form. Nothing here calls Vantage or DRMS.
 */

export type SiteStockErrorCode = 'not_found' | 'bad_value' | 'duplicate' | 'in_use' | 'empty';

/** Anything an operator can run into from the UI; always safe to show them. */
export class SiteStockError extends Error {
  constructor(
    message: string,
    readonly code: SiteStockErrorCode,
  ) {
    super(message);
    this.name = 'SiteStockError';
  }
}

const cap = (c: ReplenishColour) => (c.charAt(0).toUpperCase() + c.slice(1)) as Capitalize<ReplenishColour>;
type Partials = Partial<ShelfConsumableCounts>;

function checkCounts(kind: 'holding' | 'used', counts: Partials | undefined): Partials {
  const out: Partials = {};
  for (const c of REPLENISH_COLOURS) {
    const v = counts?.[c];
    if (v === undefined) continue;
    const max = kind === 'holding' ? MAX_HOLDING : Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(v) || v < 0 || v > max) {
      throw new SiteStockError(
        kind === 'holding' ? `A holding is a whole number from 0 to ${MAX_HOLDING}.` : 'A used count is a whole number, 0 or more.',
        'bad_value',
      );
    }
    out[c] = v;
  }
  return out;
}

/** `{ black: 2 }` becomes `{ holdingBlack: 2 }` for a column set. */
function columns(prefix: 'holding' | 'used', counts: Partials) {
  const out: Record<string, number> = {};
  for (const c of REPLENISH_COLOURS) if (counts[c] !== undefined) out[`${prefix}${cap(c)}`] = counts[c]!;
  return out;
}

function fullCounts(prefix: 'holding' | 'used', row: object): ShelfConsumableCounts {
  const out = {} as ShelfConsumableCounts;
  for (const c of REPLENISH_COLOURS) out[c] = (row as Record<string, number>)[`${prefix}${cap(c)}`] ?? 0;
  return out;
}

const MONO_MESSAGE = 'A mono family holds black and waste only.';

function monoViolation(holding: Partials): boolean {
  return (['cyan', 'magenta', 'yellow'] as const).some((c) => (holding[c] ?? 0) > 0);
}

async function audit(tx: Db, a: { userId: number | null; action: string; entity: string; ids: number[]; details: object; now: Date }) {
  await tx.insert(auditLog).values({ at: a.now, userId: a.userId, action: a.action, entity: a.entity, entityIds: a.ids, details: a.details });
}

// ---- families -------------------------------------------------------------------------------

export interface SaveFamilyArgs {
  id?: number;
  name: string;
  isColour: boolean;
  models: string[];
  ratedYield: Partial<Record<ReplenishColour, number | null>>;
  notes?: string;
  /** Null for the seed script, which has no signed-in user. */
  userId: number | null;
  now?: Date;
}

export async function saveFamily(db: Db, args: SaveFamilyArgs): Promise<{ familyId: number }> {
  const now = args.now ?? new Date();
  const name = args.name.trim();
  if (name === '') throw new SiteStockError('A family needs a name.', 'bad_value');
  const models = [...new Set(args.models.map((m) => m.trim()).filter((m) => m !== ''))];
  const yields: Record<string, number | null> = {};
  for (const c of REPLENISH_COLOURS) {
    const v = args.ratedYield[c] ?? null;
    if (v !== null && (!Number.isInteger(v) || v < 0)) throw new SiteStockError('A rated yield is a whole number of pages, 0 or more.', 'bad_value');
    yields[`ratedYield${cap(c)}`] = v;
  }
  const values = { name, isColour: args.isColour, ...yields, notes: args.notes?.trim() || null, updatedBy: args.userId, updatedAt: now };

  return db.transaction(async (tx) => {
    const f = cartridgeFamilies;
    const [clash] = await tx.select({ id: f.id }).from(f).where(sql`lower(${f.name}) = ${name.toLowerCase()}`);
    if (clash && clash.id !== args.id) throw new SiteStockError(`A family called "${name}" already exists.`, 'duplicate');

    let familyId: number;
    if (args.id === undefined) {
      const [row] = await tx.insert(f).values(values).returning({ id: f.id });
      familyId = row!.id;
    } else {
      const done = await tx.update(f).set(values).where(eq(f.id, args.id)).returning({ id: f.id });
      if (done.length === 0) throw new SiteStockError('That family no longer exists.', 'not_found');
      familyId = args.id;
    }

    const m = cartridgeFamilyModels;
    if (models.length > 0) {
      const taken = await tx
        .select({ model: m.model })
        .from(m)
        .where(and(inArray(m.model, models), sql`${m.familyId} <> ${familyId}`));
      if (taken.length > 0) {
        throw new SiteStockError(`${taken.map((t) => t.model).join(', ')} already belongs to another family.`, 'duplicate');
      }
    }
    await tx.delete(m).where(eq(m.familyId, familyId));
    if (models.length > 0) await tx.insert(m).values(models.map((model) => ({ model, familyId })));

    await audit(tx as unknown as Db, {
      userId: args.userId,
      action: args.id === undefined ? 'family.create' : 'family.update',
      entity: 'family',
      ids: [familyId],
      details: { name, isColour: args.isColour, models, ratedYield: args.ratedYield },
      now,
    });
    return { familyId };
  });
}

export async function deleteFamily(db: Db, args: { id: number; userId: number; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  await db.transaction(async (tx) => {
    const [fam] = await tx.select({ name: cartridgeFamilies.name }).from(cartridgeFamilies).where(eq(cartridgeFamilies.id, args.id));
    if (!fam) throw new SiteStockError('That family no longer exists.', 'not_found');
    const shelves = await tx.select({ id: siteStockShelves.id }).from(siteStockShelves).where(eq(siteStockShelves.familyId, args.id)).limit(1);
    if (shelves.length > 0) throw new SiteStockError('Shelves still use this family. Delete them first.', 'in_use');
    await tx.delete(cartridgeFamilies).where(eq(cartridgeFamilies.id, args.id)); // its model rows cascade
    await audit(tx as unknown as Db, { userId: args.userId, action: 'family.delete', entity: 'family', ids: [args.id], details: { name: fam.name }, now });
  });
}

// ---- shelves --------------------------------------------------------------------------------

export async function createShelf(
  db: Db,
  args: { vantageCustomerId: number; familyId: number; holding: Partials; used?: Partials; userId: number; now?: Date },
): Promise<{ shelfId: number }> {
  const now = args.now ?? new Date();
  const holding = checkCounts('holding', args.holding);
  const used = checkCounts('used', args.used);

  return db.transaction(async (tx) => {
    const s = siteStockShelves;
    const [cust] = await tx
      .select({ id: vantageCustomers.vantageId })
      .from(vantageCustomers)
      .where(eq(vantageCustomers.vantageId, args.vantageCustomerId));
    if (!cust) throw new SiteStockError('That customer is not in Vantage.', 'not_found');
    const [fam] = await tx.select({ isColour: cartridgeFamilies.isColour }).from(cartridgeFamilies).where(eq(cartridgeFamilies.id, args.familyId));
    if (!fam) throw new SiteStockError('That family no longer exists.', 'not_found');
    if (!fam.isColour && monoViolation(holding)) throw new SiteStockError(MONO_MESSAGE, 'bad_value');
    const [dupe] = await tx
      .select({ id: s.id })
      .from(s)
      .where(and(eq(s.vantageCustomerId, args.vantageCustomerId), eq(s.familyId, args.familyId)));
    if (dupe) throw new SiteStockError('This customer already has a shelf for that family.', 'duplicate');

    const [row] = await tx
      .insert(s)
      .values({
        vantageCustomerId: args.vantageCustomerId,
        familyId: args.familyId,
        ...columns('holding', holding),
        ...columns('used', used),
        countingFrom: now,
        createdBy: args.userId,
        createdAt: now,
        updatedBy: args.userId,
        updatedAt: now,
      })
      .returning({ id: s.id });
    const shelfId = row!.id;
    await audit(tx as unknown as Db, {
      userId: args.userId,
      action: 'shelf.create',
      entity: 'shelf',
      ids: [shelfId],
      details: { vantageCustomerId: args.vantageCustomerId, familyId: args.familyId, holding, used },
      now,
    });
    return { shelfId };
  });
}

/** `used` here is the audited manual correction of what has been used since the last top-up. */
export async function updateShelf(
  db: Db,
  args: { shelfId: number; holding?: Partials; used?: Partials; userId: number; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  const holding = checkCounts('holding', args.holding);
  const used = checkCounts('used', args.used);
  if (Object.keys(holding).length === 0 && Object.keys(used).length === 0) throw new SiteStockError('Nothing to change.', 'empty');

  await db.transaction(async (tx) => {
    const s = siteStockShelves;
    const [before] = await tx.select().from(s).where(eq(s.id, args.shelfId));
    if (!before) throw new SiteStockError('That shelf no longer exists.', 'not_found');
    const [fam] = await tx.select({ isColour: cartridgeFamilies.isColour }).from(cartridgeFamilies).where(eq(cartridgeFamilies.id, before.familyId));
    if (fam && !fam.isColour && monoViolation(holding)) throw new SiteStockError(MONO_MESSAGE, 'bad_value');
    const done = await tx
      .update(s)
      .set({ ...columns('holding', holding), ...columns('used', used), updatedBy: args.userId, updatedAt: now })
      .where(eq(s.id, args.shelfId))
      .returning({ id: s.id });
    if (done.length === 0) throw new SiteStockError('That shelf no longer exists.', 'not_found');
    await audit(tx as unknown as Db, {
      userId: args.userId,
      action: 'shelf.update',
      entity: 'shelf',
      ids: [args.shelfId],
      details: {
        holding: { from: fullCounts('holding', before), set: holding },
        used: { from: fullCounts('used', before), set: used },
      },
      now,
    });
  });
}

/**
 * Deletes a shelf. Its pending top-ups are superseded first. An `approved` top-up is a live order
 * waiting to go out, so the shelf cannot be deleted under it (`in_use`). Decided rows (ordered,
 * failed, rejected, superseded) keep their history: their `shelf_id` is set to null, which the
 * live-proposal unique indexes never see because those rows are not pending/approved.
 */
export async function deleteShelf(db: Db, args: { shelfId: number; userId: number; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  await db.transaction(async (tx) => {
    const p = replenishmentProposals;
    const [shelf] = await tx.select({ id: siteStockShelves.id }).from(siteStockShelves).where(eq(siteStockShelves.id, args.shelfId));
    if (!shelf) throw new SiteStockError('That shelf no longer exists.', 'not_found');
    const approved = await tx
      .select({ id: p.id })
      .from(p)
      .where(and(eq(p.shelfId, args.shelfId), eq(p.status, 'approved')))
      .limit(1);
    if (approved.length > 0) throw new SiteStockError('A top-up for this shelf is approved and waiting to be ordered. Settle it first.', 'in_use');

    const superseded = await tx
      .update(p)
      .set({ status: 'superseded', decidedAt: now, note: 'shelf deleted' })
      .where(and(eq(p.shelfId, args.shelfId), eq(p.status, 'pending')))
      .returning({ id: p.id });
    await tx.update(p).set({ shelfId: null }).where(eq(p.shelfId, args.shelfId));
    await tx.delete(siteStockShelves).where(eq(siteStockShelves.id, args.shelfId)); // events cascade
    await audit(tx as unknown as Db, {
      userId: args.userId,
      action: 'shelf.delete',
      entity: 'shelf',
      ids: [args.shelfId],
      details: { supersededProposalIds: superseded.map((r) => r.id) },
      now,
    });
  });
}

/** Clears an explicit "auto-order off" on the shelf's devices so the shelf's top-up can take over. */
export async function resetAutoReplenishForShelf(
  db: Db,
  args: { shelfId: number; userId: number; now?: Date },
): Promise<{ updated: number }> {
  const sd = shelfDevicesSubquery(db);
  const rs = replenishmentSettings;
  const rows = await db
    .select({ drmsId: sd.drmsId })
    .from(sd)
    .innerJoin(rs, and(eq(rs.drmsEquipmentId, sd.drmsId), eq(rs.scope, 'device'), eq(rs.autoReplenish, false)))
    .where(eq(sd.shelfId, args.shelfId));
  if (rows.length === 0) return { updated: 0 };
  return updateDeviceSettings(db, { drmsIds: rows.map((r) => r.drmsId), patch: { autoReplenish: null }, userId: args.userId, now: args.now });
}

// ---- CSV import -----------------------------------------------------------------------------

export interface ImportPreviewRow {
  line: number;
  vantageCustomerId: number;
  siteName: string;
  family: string;
  action: 'create' | 'update' | 'unchanged' | 'error';
  message?: string;
  changes: string[];
}

export async function previewImport(db: Db, rows: ImportRow[]): Promise<ImportPreviewRow[]> {
  return (await plan(db, rows)).map((p) => p.preview);
}

interface Planned {
  preview: ImportPreviewRow;
  row: ImportRow;
  familyId?: number;
  shelfId?: number;
}

async function plan(db: Db, rows: ImportRow[]): Promise<Planned[]> {
  const customerIds = [...new Set(rows.map((r) => r.vantageCustomerId))];
  const customers = customerIds.length
    ? await db
        .select({ id: vantageCustomers.vantageId, name: vantageCustomers.name })
        .from(vantageCustomers)
        .where(inArray(vantageCustomers.vantageId, customerIds))
    : [];
  const customerName = new Map(customers.map((c) => [c.id, c.name ?? '']));
  const families = await db
    .select({ id: cartridgeFamilies.id, name: cartridgeFamilies.name, isColour: cartridgeFamilies.isColour })
    .from(cartridgeFamilies);
  const familyByName = new Map(families.map((f) => [f.name.toLowerCase(), f]));
  const shelves = customerIds.length ? await db.select().from(siteStockShelves).where(inArray(siteStockShelves.vantageCustomerId, customerIds)) : [];
  const shelfByKey = new Map(shelves.map((s) => [`${s.vantageCustomerId}:${s.familyId}`, s]));

  return rows.map((row): Planned => {
    const base = { line: row.line, vantageCustomerId: row.vantageCustomerId, siteName: customerName.get(row.vantageCustomerId) ?? '', family: row.family };
    const fail = (message: string): Planned => ({ preview: { ...base, action: 'error', message, changes: [] }, row });
    if (!customerName.has(row.vantageCustomerId)) return fail(`Unknown customer id ${row.vantageCustomerId}`);
    const family = familyByName.get(row.family.toLowerCase());
    if (family === undefined) return fail(`Unknown family "${row.family}"`);
    if (!family.isColour && monoViolation(row.holding)) return fail(MONO_MESSAGE);
    const familyId = family.id;

    const shelf = shelfByKey.get(`${row.vantageCustomerId}:${familyId}`);
    if (!shelf) {
      if (REPLENISH_COLOURS.every((c) => row.holding[c] === 0)) {
        return { preview: { ...base, action: 'unchanged', message: 'Nothing held, so no shelf is created', changes: [] }, row, familyId };
      }
      const changes = REPLENISH_COLOURS.filter((c) => row.holding[c] > 0).map((c) => `${c} 0 to ${row.holding[c]}`);
      return { preview: { ...base, action: 'create', changes }, row, familyId };
    }
    const current = fullCounts('holding', shelf);
    const changes = REPLENISH_COLOURS.filter((c) => current[c] !== row.holding[c]).map((c) => `${c} ${current[c]} to ${row.holding[c]}`);
    return { preview: { ...base, action: changes.length > 0 ? 'update' : 'unchanged', changes }, row, familyId, shelfId: shelf.id };
  });
}

/**
 * Applies a validated import all or nothing. The preview is re-run inside the transaction, so
 * anything that changed since the operator looked is caught. An update writes holdings only (the
 * file's `used_*` is ignored); a create also takes `used_*`.
 */
export async function applyImport(
  db: Db,
  args: { rows: ImportRow[]; userId: number; now?: Date },
): Promise<{ created: number; updated: number; unchanged: number }> {
  const now = args.now ?? new Date();
  if (args.rows.length === 0) throw new SiteStockError('The file has no rows to import.', 'empty');

  return db.transaction(async (tx) => {
    const planned = await plan(tx as unknown as Db, args.rows);
    const errors = planned.filter((p) => p.preview.action === 'error');
    if (errors.length > 0) {
      throw new SiteStockError(errors.map((e) => `Line ${e.preview.line}: ${e.preview.message}`).join('; '), 'bad_value');
    }
    const s = siteStockShelves;
    const createdIds: number[] = [];
    const updatedIds: number[] = [];
    let unchanged = 0;
    for (const p of planned) {
      if (p.preview.action === 'create') {
        const [row] = await tx
          .insert(s)
          .values({
            vantageCustomerId: p.row.vantageCustomerId,
            familyId: p.familyId!,
            ...columns('holding', p.row.holding),
            ...columns('used', p.row.used),
            countingFrom: now,
            createdBy: args.userId,
            createdAt: now,
            updatedBy: args.userId,
            updatedAt: now,
          })
          .returning({ id: s.id });
        createdIds.push(row!.id);
      } else if (p.preview.action === 'update') {
        await tx.update(s).set({ ...columns('holding', p.row.holding), updatedBy: args.userId, updatedAt: now }).where(eq(s.id, p.shelfId!));
        updatedIds.push(p.shelfId!);
      } else {
        unchanged++;
      }
    }
    await audit(tx as unknown as Db, {
      userId: args.userId,
      action: 'shelf.import',
      entity: 'shelf',
      ids: [...createdIds, ...updatedIds],
      details: { created: createdIds, updated: updatedIds, unchanged },
      now,
    });
    return { created: createdIds.length, updated: updatedIds.length, unchanged };
  });
}
