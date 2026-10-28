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
 *   (blank line)
 *   match_model,match_part,order_lines     (order lines behind each model-to-part match)
 *   ...
 *
 * WARN lines (a family merge resting on one order line; a part matched by both a mono and a
 * colour model) go to stderr so stdout stays parseable.
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
  /** How many order lines carry this text and part (default 1). */
  count?: number;
}
export interface PartGroup {
  /** One part code, or the merged codes joined with ", " when several parts share models. */
  part: string;
  models: string[];
}
/** The number of order lines behind one model-to-part match. */
export interface MatchEvidence {
  model: string;
  part: string;
  lines: number;
}
export interface FamilyAnalysis {
  groups: PartGroup[];
  evidence: MatchEvidence[];
  warnings: string[];
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
  /** The line is known to describe a colour machine (a C-model token, "Ineo +300i" / "Develop +300i", or a cyan, magenta or yellow cartridge). */
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
  const colour = /(?:ineo|develop)\s*\+|\+\s*\d{3}|\b(?:cyan|magenta|yellow)\b/.test(text) || [...tokens].some((t) => /^c\d/.test(t));
  return { tokens, colour };
}

/**
 * Groups models by cartridge part, never mixing mono and colour models, and reports the evidence.
 *
 * Per order line (tokenise), a colour model (isColourModel: C-model, ineo+, MF) matches the part
 * when the line names its C-token ("c300"), or its bare number ("300") but only on a line known to
 * describe a colour machine (a C-token, "Ineo +300i", or a cyan, magenta or yellow cartridge). A
 * mono model matches only a bare number on a line that is not a colour line. Parts that share a
 * model are merged (union-find) within the same colour class, so a family is all-mono or
 * all-colour. Parts matching no model are dropped; models are returned sorted, groups by part.
 *
 * `evidence` is the number of order lines behind each model-to-part match. `warnings` flag a
 * family merge that rests on a single order line, and a part that lands in both a mono and a
 * colour family.
 */
export function analyseFamilies(lines: PartLine[], models: string[]): FamilyAnalysis {
  const modelInfo = models.map((model) => ({ model, num: modelNumber(model), colour: isColourModel(model) }));
  const matched = new Map<string, Map<string, number>>(); // "c:PART" / "m:PART" -> model -> order lines
  for (const line of lines) {
    const part = partOf(line);
    if (!part) continue;
    const { tokens, colour: colourLine } = tokenise(line.details);
    for (const { model, num, colour } of modelInfo) {
      if (!num) continue;
      const hit = colour ? tokens.has(`c${num}`) || (colourLine && tokens.has(num)) : !colourLine && tokens.has(num);
      if (!hit) continue;
      const node = `${colour ? 'c' : 'm'}:${part}`;
      const byModel = matched.get(node) ?? new Map<string, number>();
      byModel.set(model, (byModel.get(model) ?? 0) + (line.count ?? 1));
      matched.set(node, byModel);
    }
  }

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const node of matched.keys()) parent.set(node, node);
  const warnings: string[] = [];
  const firstNodeOfModel = new Map<string, string>();
  for (const [node, byModel] of matched) {
    for (const [m, n] of byModel) {
      const first = firstNodeOfModel.get(m);
      if (first) {
        if (find(first) !== find(node)) {
          const firstLines = matched.get(first)!.get(m)!;
          if (Math.min(firstLines, n) === 1) {
            warnings.push(
              `WARN single-line merge: ${first.slice(2)} and ${node.slice(2)} are joined only through ${m} (${firstLines} line(s) for ${first.slice(2)}, ${n} for ${node.slice(2)})`,
            );
          }
        }
        parent.set(find(first), find(node));
      } else firstNodeOfModel.set(m, node);
    }
  }

  const groups = new Map<string, { parts: Set<string>; models: Set<string> }>();
  for (const [node, byModel] of matched) {
    const root = find(node);
    const g = groups.get(root) ?? { parts: new Set<string>(), models: new Set<string>() };
    g.parts.add(node.slice(2));
    for (const m of byModel.keys()) g.models.add(m);
    groups.set(root, g);
  }

  for (const node of matched.keys()) {
    if (!node.startsWith('m:') || !matched.has(`c:${node.slice(2)}`)) continue;
    const part = node.slice(2);
    warnings.push(
      `WARN mono and colour: ${part} matches mono ${[...matched.get(node)!.keys()].sort().join(' | ')} and colour ${[...matched.get(`c:${part}`)!.keys()].sort().join(' | ')}`,
    );
  }

  const evidence = [...matched].flatMap(([node, byModel]) =>
    [...byModel].map(([model, n]) => ({ model, part: node.slice(2), lines: n })),
  );
  evidence.sort((a, b) => a.model.localeCompare(b.model) || a.part.localeCompare(b.part));
  return {
    groups: [...groups.values()]
      .map((g) => ({ part: [...g.parts].sort().join(', '), models: [...g.models].sort() }))
      .sort((a, b) => a.part.localeCompare(b.part)),
    evidence,
    warnings: warnings.sort(),
  };
}

/** Groups only; see analyseFamilies. */
export function groupModelsByPart(lines: PartLine[], models: string[]): PartGroup[] {
  return analyseFamilies(lines, models).groups;
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

export function renderCsv(groups: PartGroup[], unmapped: { model: string; devices: number }[], evidence: MatchEvidence[] = []): string {
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
  if (evidence.length > 0) {
    out.push('', 'match_model,match_part,order_lines');
    for (const e of evidence) out.push([e.model, e.part, String(e.lines)].map(csvCell).join(','));
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const { db, pool } = createDb(process.env.DATABASE_URL!);
  try {
    const lines = await db
      .select({ details: vantageSalesOrderLines.details, partNumber: vantageSalesOrderLines.itemPartNumber, count: count() })
      .from(vantageSalesOrderLines)
      .where(isNotNull(vantageSalesOrderLines.details))
      .groupBy(vantageSalesOrderLines.details, vantageSalesOrderLines.itemPartNumber);
    const modelRows = await db
      .select({ model: drmsEquipment.modelName, devices: count() })
      .from(drmsEquipment)
      .innerJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
      .where(isNotNull(drmsEquipment.modelName))
      .groupBy(drmsEquipment.modelName);

    const { groups, evidence, warnings } = analyseFamilies(
      lines.map((l) => ({ details: l.details ?? '', partNumber: l.partNumber, count: l.count })),
      modelRows.map((r) => r.model!),
    );
    const mapped = new Set(groups.flatMap((g) => g.models));
    const unmapped = modelRows
      .filter((r) => !mapped.has(r.model!))
      .map((r) => ({ model: r.model!, devices: r.devices }))
      .sort((a, b) => b.devices - a.devices || a.model.localeCompare(b.model));
    console.log(renderCsv(groups, unmapped, evidence));
    // Warnings go to stderr, so stdout stays a parseable CSV (families, unmapped, match evidence).
    for (const w of warnings) console.error(w);
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
