/**
 * Read-only: proposes cartridge families by joining KM cartridge part codes (e.g. ACV1150) to the
 * DRMS models whose number appears in the sales-order line text for that part, then prints the
 * proposal as CSV to stdout for the user to confirm before `cartridge-families.json` is written.
 *
 *   family,is_colour,parts,models
 *   ...
 *   (blank line)
 *   unmapped_model,devices
 *   ...
 *
 * Part code: `vantage_sales_order_lines.item_part_number` when it looks like a KM code
 * (three capital letters + four digits), otherwise the first such code found in `details`. Lines
 * with neither are ignored (machines, paper, MISC).
 *
 * Usage:
 *   cd apps/worker && npx tsx --env-file=../../.env scripts/derive-cartridge-families.ts
 */
import { isColourModel } from '@mps/core';
import { createDb, deviceLinks, drmsEquipment, vantageSalesOrderLines } from '@mps/db';
import { and, count, eq, isNotNull, isNull } from 'drizzle-orm';

const PART_CODE = /\b[A-Z]{3}\d{4}\b/;
const PART_CODE_EXACT = /^[A-Z]{3}\d{4}$/;

export interface PartLine {
  details: string;
  partNumber: string | null;
}
export interface PartGroup {
  /** One part code, or the merged codes joined with ", " when several parts share models. */
  part: string;
  models: string[];
}

/** The model's number token, keeping a colour C: "bizhub C450i" -> "c450i", "ineo+ 300i" -> "300i"; null if none. */
function modelKey(model: string): string | null {
  const m = /(c?\d{3,4}[a-z]*)\s*$/i.exec(model.trim());
  return m ? m[1]!.toLowerCase() : null;
}

function partOf(line: PartLine): string | null {
  const direct = line.partNumber?.trim().toUpperCase();
  if (direct && PART_CODE_EXACT.test(direct)) return direct;
  return PART_CODE.exec(line.details)?.[0] ?? null;
}

/**
 * Groups models by cartridge part: a model joins a part when its number token (case-insensitive,
 * the colour C kept; a bare number only claims a colour model when no mono sibling exists) appears as a whole token in any line text for that part. Parts that share a
 * model are merged (union-find) into one group. Parts matching no model are dropped; models are
 * returned sorted, groups sorted by part.
 */
export function groupModelsByPart(lines: PartLine[], models: string[]): PartGroup[] {
  const tokensByPart = new Map<string, Set<string>>();
  for (const line of lines) {
    const part = partOf(line);
    if (!part) continue;
    const set = tokensByPart.get(part) ?? new Set<string>();
    for (const t of line.details.toLowerCase().split(/[^a-z0-9]+/)) if (t) set.add(t);
    tokensByPart.set(part, set);
  }

  // A colour model (c300i) matches its own token, and the bare token (300i) only when no mono
  // model with that number exists; a mono model matches the bare token only.
  const monoKeys = new Set(models.map(modelKey).filter((k): k is string => k !== null && !/^c\d/.test(k)));
  const matched = new Map<string, string[]>(); // part -> models
  for (const [part, tokens] of tokensByPart) {
    for (const model of models) {
      const key = modelKey(model);
      if (!key) continue;
      const bare = key.slice(1);
      const isC = /^c\d/.test(key);
      if (tokens.has(key) || (isC && !monoKeys.has(bare) && tokens.has(bare))) {
        matched.set(part, [...(matched.get(part) ?? []), model]);
      }
    }
  }

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const part of matched.keys()) parent.set(part, part);
  const firstPartOfModel = new Map<string, string>();
  for (const [part, ms] of matched) {
    for (const m of ms) {
      const first = firstPartOfModel.get(m);
      if (first) parent.set(find(first), find(part));
      else firstPartOfModel.set(m, part);
    }
  }

  const groups = new Map<string, { parts: Set<string>; models: Set<string> }>();
  for (const [part, ms] of matched) {
    const root = find(part);
    const g = groups.get(root) ?? { parts: new Set<string>(), models: new Set<string>() };
    g.parts.add(part);
    for (const m of ms) g.models.add(m);
    groups.set(root, g);
  }
  return [...groups.values()]
    .map((g) => ({ part: [...g.parts].sort().join(', '), models: [...g.models].sort() }))
    .sort((a, b) => a.part.localeCompare(b.part));
}

/** "bizhub C450i" -> "C450i"; "ineo+ 300i" -> "300i". */
export function shortModel(model: string): string {
  return model.replace(/^(bizhub|ineo\+?)\s*/i, '').trim() || model;
}

export function familyName(models: string[]): string {
  return models.map(shortModel).join(' / ');
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function renderCsv(groups: PartGroup[], unmapped: { model: string; devices: number }[]): string {
  const out = ['family,is_colour,parts,models'];
  for (const g of groups) {
    out.push(
      [familyName(g.models), String(g.models.every((m) => isColourModel(m))), g.part, g.models.join(' | ')]
        .map(csvCell)
        .join(','),
    );
  }
  out.push('', 'unmapped_model,devices');
  for (const u of unmapped) out.push([u.model, String(u.devices)].map(csvCell).join(','));
  return out.join('\n');
}

async function main(): Promise<void> {
  const { db, pool } = createDb(process.env.DATABASE_URL!);
  try {
    const lines = await db
      .selectDistinct({ details: vantageSalesOrderLines.details, partNumber: vantageSalesOrderLines.itemPartNumber })
      .from(vantageSalesOrderLines)
      .where(isNotNull(vantageSalesOrderLines.details));
    const modelRows = await db
      .select({ model: drmsEquipment.modelName, devices: count() })
      .from(drmsEquipment)
      .innerJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
      .where(isNotNull(drmsEquipment.modelName))
      .groupBy(drmsEquipment.modelName);

    const groups = groupModelsByPart(
      lines.map((l) => ({ details: l.details ?? '', partNumber: l.partNumber })),
      modelRows.map((r) => r.model!),
    );
    const mapped = new Set(groups.flatMap((g) => g.models));
    const unmapped = modelRows
      .filter((r) => !mapped.has(r.model!))
      .map((r) => ({ model: r.model!, devices: r.devices }))
      .sort((a, b) => b.devices - a.devices || a.model.localeCompare(b.model));
    console.log(renderCsv(groups, unmapped));
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('derive-cartridge-families.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
