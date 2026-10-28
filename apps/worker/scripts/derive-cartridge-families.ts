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
 * (e.g. AAV8150, AAJW150, ACTD050), otherwise the first such code found in `details`. Lines
 * with neither are ignored (machines, paper, MISC).
 *
 * Usage:
 *   cd apps/worker && npx tsx --env-file=../../.env scripts/derive-cartridge-families.ts
 */
import { isColourModel } from '@mps/core';
import { createDb, deviceLinks, drmsEquipment, vantageSalesOrderLines } from '@mps/db';
import { and, count, eq, isNotNull, isNull } from 'drizzle-orm';

// KM cartridge codes: AAV8150 (3 letters + 4 digits) and AAJW150 / ACTD050 / ACVH150 (A + 2 letters + letter-or-digit + 3 digits).
const PART_SHAPE = '(?:[A-Z]{3}\\d{4}|A[A-Z]{2}[A-Z0-9]\\d{3})';
const PART_CODE = new RegExp(`\\b${PART_SHAPE}\\b`);
const PART_CODE_EXACT = new RegExp(`^${PART_SHAPE}$`);

export interface PartLine {
  details: string;
  partNumber: string | null;
}
export interface PartGroup {
  /** One part code, or the merged codes joined with ", " when several parts share models. */
  part: string;
  models: string[];
}

/** Model number without colour C or trailing "i": "bizhub C450i" -> "450", "ineo+ 300i" -> "300", "ineo+3351" -> "3351". */
function modelNumber(model: string): string | null {
  const m = /c?(\d{3,4}[a-z]*?)i?\s*$/i.exec(model.trim());
  return m ? m[1]!.toLowerCase() : null;
}

function partOf(line: PartLine): string | null {
  const direct = line.partNumber?.trim().toUpperCase();
  if (direct && PART_CODE_EXACT.test(direct)) return direct;
  return PART_CODE.exec(line.details)?.[0] ?? null;
}

interface LineTokens {
  /** Number tokens as written, a colour C kept, trailing "i" dropped: "c300", "250", "3350". */
  tokens: Set<string>;
  /** The line is known to describe a colour machine (a C-model token, or "Ineo +300i" / "Develop +300i"). */
  colour: boolean;
}

function tokenise(details: string): LineTokens {
  let text = details.toLowerCase();
  const tokens = new Set<string>();
  // Shorthand "c3350/1i" -> c3350, c3351; "c750/751i" -> c750, c751 (the C applies to both).
  text = text
    .replace(/\b(c?)(\d{3,4})\/(\d{3,4})i?\b/g, (_m, c: string, a: string, b: string) => {
      tokens.add(`${c}${a}`);
      tokens.add(`${c}${b}`);
      return ' ';
    })
    .replace(/\b(c?)(\d{2,3})(\d)\/(\d)i?\b/g, (_m, c: string, pre: string, d1: string, d2: string) => {
      tokens.add(`${c}${pre}${d1}`);
      tokens.add(`${c}${pre}${d2}`);
      return ' ';
    });
  for (const raw of text.split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    const t = raw.replace(/^0+(?=c\d)/, '').replace(/(?<=\d)i$/, '');
    if (/^c?\d{3,4}[a-z]*$/.test(t)) tokens.add(t);
  }
  const colour = /(?:ineo|develop)\s*\+|\+\s*\d{3}/.test(text) || [...tokens].some((t) => /^c\d/.test(t));
  return { tokens, colour };
}

/**
 * Groups models by cartridge part, never mixing mono and colour models.
 *
 * A colour model (isColourModel: C-model, ineo+, MF) matches the part when a line names its C-token
 * ("c300"), or its bare number ("300") when no mono model has that number and the part matched no
 * mono model. A mono model matches only a bare number written on a line that is not known to be a
 * colour line: shorthand on colour lines ("Develop +250i", "C750/751i") is ignored for mono models.
 * Parts that share a model are merged (union-find) within the same colour class, so a family is
 * all-mono or all-colour. Parts matching no model are dropped; models are returned sorted, groups
 * sorted by part.
 */
export function groupModelsByPart(lines: PartLine[], models: string[]): PartGroup[] {
  const monoTokens = new Map<string, Set<string>>(); // bare numbers on non-colour lines
  const allTokens = new Map<string, Set<string>>(); // every token on the part's lines
  for (const line of lines) {
    const part = partOf(line);
    if (!part) continue;
    const { tokens, colour } = tokenise(line.details);
    const all = allTokens.get(part) ?? new Set<string>();
    const mono = monoTokens.get(part) ?? new Set<string>();
    for (const t of tokens) {
      all.add(t);
      if (!colour && !t.startsWith('c')) mono.add(t);
    }
    allTokens.set(part, all);
    monoTokens.set(part, mono);
  }

  const monoNumbers = new Set(models.filter((m) => !isColourModel(m)).map(modelNumber));
  const matched = new Map<string, string[]>(); // "c:PART" / "m:PART" -> models
  for (const [part, all] of allTokens) {
    const mono = monoTokens.get(part)!;
    const monoHit = models.some((m) => !isColourModel(m) && mono.has(modelNumber(m) ?? ''));
    for (const model of models) {
      const num = modelNumber(model);
      if (!num) continue;
      const colour = isColourModel(model);
      const hit = colour ? all.has(`c${num}`) || (!monoNumbers.has(num) && !monoHit && all.has(num)) : mono.has(num);
      if (hit) {
        const node = `${colour ? 'c' : 'm'}:${part}`;
        matched.set(node, [...(matched.get(node) ?? []), model]);
      }
    }
  }

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const node of matched.keys()) parent.set(node, node);
  const firstNodeOfModel = new Map<string, string>();
  for (const [node, ms] of matched) {
    for (const m of ms) {
      const first = firstNodeOfModel.get(m);
      if (first) parent.set(find(first), find(node));
      else firstNodeOfModel.set(m, node);
    }
  }

  const groups = new Map<string, { parts: Set<string>; models: Set<string> }>();
  for (const [node, ms] of matched) {
    const root = find(node);
    const g = groups.get(root) ?? { parts: new Set<string>(), models: new Set<string>() };
    g.parts.add(node.slice(2));
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

/** Short names joined with " / "; an ineo+ rebadge whose bizhub C twin is listed ("300i" beside "C300i") is not repeated. */
export function familyName(models: string[]): string {
  const names = models.map(shortModel);
  return names.filter((n, i) => !names.includes(`C${n}`) && names.indexOf(n) === i).join(' / ');
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
