/**
 * Seeds `cartridge_families` / `cartridge_family_models` from the user-confirmed
 * `cartridge-families.json` (same folder): `[{ "name", "isColour", "models": [...] }]`.
 *
 * Dry run by default; `--apply` inserts. Only ever adds: a family whose name already exists
 * (case-insensitive) is left completely alone, and a model that already belongs to any family is
 * dropped from the family being created (reported as skipped). Inserts go through `saveFamily`
 * with `userId: null`, so each new family writes its usual audit row.
 *
 * Usage:
 *   cd apps/worker && npx tsx --env-file=../../.env scripts/seed-cartridge-families.ts            # dry run
 *   cd apps/worker && npx tsx --env-file=../../.env scripts/seed-cartridge-families.ts --apply
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, cartridgeFamilies, cartridgeFamilyModels, type Db } from '@mps/db';
import { saveFamily } from '@mps/db/queries';

export interface SeedFamily {
  name: string;
  isColour: boolean;
  models: string[];
}

export interface SeedPlan {
  create: SeedFamily[];
  /** Families already present by name: untouched. */
  existing: string[];
  /** Models dropped from a family to create because another family already owns them. */
  skippedModels: { family: string; model: string }[];
}

/** Validates the parsed JSON; throws a readable error on the first problem. */
export function parseSeedFile(raw: unknown): SeedFamily[] {
  if (!Array.isArray(raw)) throw new Error('cartridge-families.json must be a JSON array.');
  return raw.map((f, i) => {
    const where = `cartridge-families.json entry ${i + 1}`;
    if (typeof f !== 'object' || f === null) throw new Error(`${where} is not an object.`);
    const { name, isColour, models } = f as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim() === '') throw new Error(`${where} needs a "name".`);
    if (typeof isColour !== 'boolean') throw new Error(`${where} ("${name}") needs a boolean "isColour".`);
    if (!Array.isArray(models) || models.some((m) => typeof m !== 'string' || m.trim() === '')) {
      throw new Error(`${where} ("${name}") needs "models" as an array of non-empty strings.`);
    }
    return { name: name.trim(), isColour, models: [...new Set((models as string[]).map((m) => m.trim()))] };
  });
}

/** Pure: decides what to insert given what the database already holds. */
export function planSeed(wanted: SeedFamily[], existingNames: string[], existingModels: string[]): SeedPlan {
  const names = new Set(existingNames.map((n) => n.toLowerCase()));
  const taken = new Set(existingModels);
  const plan: SeedPlan = { create: [], existing: [], skippedModels: [] };
  for (const f of wanted) {
    if (names.has(f.name.toLowerCase())) {
      plan.existing.push(f.name);
      continue;
    }
    const models: string[] = [];
    for (const m of f.models) {
      if (taken.has(m)) plan.skippedModels.push({ family: f.name, model: m });
      else {
        models.push(m);
        taken.add(m);
      }
    }
    if (models.length === 0 && f.models.length > 0) continue; // every model already owned: nothing to create
    names.add(f.name.toLowerCase());
    plan.create.push({ ...f, models });
  }
  return plan;
}

export async function seedCartridgeFamilies(db: Db, wanted: SeedFamily[], opts: { apply: boolean }): Promise<SeedPlan> {
  const [fams, mods] = await Promise.all([
    db.select({ name: cartridgeFamilies.name }).from(cartridgeFamilies),
    db.select({ model: cartridgeFamilyModels.model }).from(cartridgeFamilyModels),
  ]);
  const plan = planSeed(
    wanted,
    fams.map((f) => f.name),
    mods.map((m) => m.model),
  );
  if (opts.apply) {
    for (const f of plan.create) {
      await saveFamily(db, { name: f.name, isColour: f.isColour, models: f.models, ratedYield: {}, userId: null });
    }
  }
  return plan;
}

function printPlan(plan: SeedPlan, apply: boolean): void {
  console.log(apply ? `created ${plan.create.length} family(ies)` : `would create ${plan.create.length} family(ies) (dry run, pass --apply to write)`);
  for (const f of plan.create) console.log(`  + ${f.name} [${f.isColour ? 'colour' : 'mono'}]: ${f.models.join(', ') || '(no models)'}`);
  for (const n of plan.existing) console.log(`  = ${n} already exists, left alone`);
  for (const s of plan.skippedModels) console.log(`  ! ${s.model} skipped for ${s.family}: already in another family`);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const file = join(dirname(fileURLToPath(import.meta.url)), 'cartridge-families.json');
  if (!existsSync(file)) {
    console.error(
      `Missing ${file}.\nRun derive-cartridge-families.ts, confirm the family list, then save it as cartridge-families.json ` +
        '([{ "name": "...", "isColour": true, "models": ["bizhub C450i"] }]).',
    );
    process.exit(1);
  }
  const wanted = parseSeedFile(JSON.parse(readFileSync(file, 'utf8')));
  const { db, pool } = createDb(process.env.DATABASE_URL!);
  try {
    printPlan(await seedCartridgeFamilies(db, wanted, { apply }), apply);
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('seed-cartridge-families.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
