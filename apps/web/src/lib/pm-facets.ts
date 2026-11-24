import type { PmRow } from '@mps/db/queries';
// Relative, not `@/`: vitest has no path alias. Only types come from @mps/db, so this module is client-safe.
import { PM_STATUSES } from './pm-statuses';

export const PM_FACETS = ['town', 'county', 'status', 'family', 'customer'] as const;
export type PmFacet = (typeof PM_FACETS)[number];
export type PmFacetSelection = Record<PmFacet, string[]>;

const tidy = (t: string | null): string => (t ?? '').trim().replace(/\s+/g, ' ');

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function all(params: Params, key: string): string[] {
  if (params instanceof URLSearchParams) return params.getAll(key);
  const v = params[key];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/**
 * All values per facet key: trimmed, non-empty, de-duplicated by their match key (so `town=Newbury&town=newbury`
 * is one value; the first spelling is kept); junk status/family values dropped.
 */
export function parsePmFacets(params: Params): PmFacetSelection {
  const out = {} as PmFacetSelection;
  for (const f of PM_FACETS) {
    const byKey = new Map<string, string>();
    for (const raw of all(params, f)) {
      const v = f === 'customer' ? tidy(raw) : raw.trim();
      const k = facetKey(f, v);
      if (v && k && !byKey.has(k)) byKey.set(k, v);
    }
    const vals = [...byKey.values()];
    out[f] =
      f === 'status'
        ? vals.filter((v) => (PM_STATUSES as readonly string[]).includes(v))
        : f === 'family'
          ? vals.filter((v) => /^\d+$/.test(v))
          : vals;
  }
  return out;
}

/** Trimmed, case-folded, whitespace-collapsed; '' for blank. */
export function townKey(town: string | null): string {
  return tidy(town).toLowerCase();
}

export function countyOf(r: PmRow): string {
  return r.areaCounty?.trim() || r.county?.trim() || 'Unknown';
}

export function facetValue(r: PmRow, f: PmFacet): string {
  switch (f) {
    case 'town':
      return townKey(r.town);
    case 'county':
      return countyOf(r);
    case 'status':
      return r.result.status;
    case 'family':
      return r.familyId === null ? '' : String(r.familyId);
    case 'customer':
      return tidy(r.customerName).toLowerCase();
  }
}

/** A selected value as `facetValue` spells it: town and customer are case-folded, the rest as given. */
export function facetKey(f: PmFacet, v: string): string {
  return f === 'town' || f === 'customer' ? tidy(v).toLowerCase() : v;
}

/**
 * Rows matching every active facet (OR within a facet, AND across). A customer value that matches no
 * row exactly falls back to a substring match, so older links (`?customer=` from the customer page,
 * bookmarks from when the filter was a substring search) still find their machines.
 */
export function applyPmFacets(rows: PmRow[], sel: PmFacetSelection, except?: PmFacet): PmRow[] {
  const active = PM_FACETS.filter((f) => f !== except && sel[f].length > 0);
  if (active.length === 0) return rows;
  const tests = active.map((f) => {
    const keys = new Set(sel[f].map((v) => facetKey(f, v)));
    if (f !== 'customer') return (r: PmRow) => keys.has(facetValue(r, f));
    const present = new Set(rows.map((r) => facetValue(r, f)));
    const subs = [...keys].filter((k) => !present.has(k));
    return (r: PmRow) => {
      const v = facetValue(r, f);
      return keys.has(v) || subs.some((s) => v.includes(s));
    };
  });
  return rows.filter((r) => tests.every((t) => t(r)));
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
  checked: boolean;
}

/** Most common spelling; ties go to the first alphabetically. */
function mostCommon(names: Map<string, number>): string {
  return [...names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

export function facetOptions(rows: PmRow[], sel: PmFacetSelection, f: PmFacet, labels?: Map<string, string>): FacetOption[] {
  const counts = new Map<string, number>();
  for (const r of applyPmFacets(rows, sel, f)) {
    const v = facetValue(r, f);
    if (v !== '') counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  // Display names come from all rows, so a zero-count ticked option still reads well.
  // Town and customer values are case-folded keys: each shows its most common spelling.
  const spellings = new Map<string, Map<string, number>>();
  const famNames = new Map<string, string>();
  if (f === 'town' || f === 'customer' || f === 'family') {
    for (const r of rows) {
      const v = facetValue(r, f);
      if (v === '') continue;
      if (f === 'family') {
        if (r.family) famNames.set(v, r.family);
        continue;
      }
      const name = tidy(f === 'town' ? r.town : r.customerName);
      const m = spellings.get(v) ?? new Map<string, number>();
      m.set(name, (m.get(name) ?? 0) + 1);
      spellings.set(v, m);
    }
  }
  const ticked = new Map(sel[f].map((v) => [facetKey(f, v), v] as const));
  const nameOf = (v: string): string => {
    if (f === 'town' || f === 'customer') return spellings.has(v) ? mostCommon(spellings.get(v)!) : (ticked.get(v) ?? v);
    if (f === 'family') return labels?.get(v) ?? famNames.get(v) ?? v;
    return labels?.get(v) ?? v;
  };
  const values = new Set([...counts.keys(), ...ticked.keys()]);
  return [...values]
    .map((value) => ({ value, label: nameOf(value), count: counts.get(value) ?? 0, checked: ticked.has(value) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export interface TownGroup {
  key: string;
  label: string;
  due: number;
  overdue: number;
  priority: number;
  rows: PmRow[];
}

export function groupByTown(rows: PmRow[], order: 'worst' | 'az'): TownGroup[] {
  const map = new Map<string, TownGroup>();
  const spell = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const key = townKey(r.town);
    let g = map.get(key);
    if (!g) {
      g = { key, label: 'No town', due: 0, overdue: 0, priority: 0, rows: [] };
      map.set(key, g);
    }
    g.rows.push(r);
    g.due += 1;
    if (r.result.status === 'overdue') g.overdue += 1;
    if (r.plan.priority) g.priority += 1;
    if (key !== '') {
      const m = spell.get(key) ?? new Map<string, number>();
      m.set(tidy(r.town), (m.get(tidy(r.town)) ?? 0) + 1);
      spell.set(key, m);
    }
  }
  for (const [key, g] of map) if (key !== '') g.label = mostCommon(spell.get(key)!);
  const byName = (a: TownGroup, b: TownGroup) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  const cmp = order === 'az' ? byName : (a: TownGroup, b: TownGroup) => b.overdue - a.overdue || b.due - a.due || byName(a, b);
  const groups = [...map.values()];
  return [...groups.filter((g) => g.key !== '').sort(cmp), ...groups.filter((g) => g.key === '')];
}

export interface PageSlice {
  group: TownGroup;
  rows: PmRow[];
  continued: boolean;
}

/** Page `page` (1-based) of `perPage` machines across the groups; header rows do not count. */
export function pageTownGroups(groups: TownGroup[], page: number, perPage: number): PageSlice[] {
  const start = (Math.max(1, page) - 1) * perPage;
  const end = start + perPage;
  const out: PageSlice[] = [];
  let offset = 0;
  for (const group of groups) {
    const gs = offset;
    const ge = offset + group.rows.length;
    offset = ge;
    if (ge <= start) continue;
    if (gs >= end) break;
    const from = Math.max(start, gs) - gs;
    const to = Math.min(end, ge) - gs;
    out.push({ group, rows: group.rows.slice(from, to), continued: from > 0 });
  }
  return out;
}

export function townHeader(g: TownGroup): string {
  return `${g.label} · ${g.due} due · ${g.overdue} overdue${g.priority > 0 ? ` · ★ ${g.priority}` : ''}`;
}
