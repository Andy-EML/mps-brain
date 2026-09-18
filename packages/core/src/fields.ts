export function normaliseSerial(value: string | null | undefined): string | null {
  if (value == null) return null;
  const s = value.trim().toUpperCase().replace(/[\s-]/g, '');
  return s === '' ? null : s;
}

export function normaliseKey(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const s = String(value).trim().toUpperCase();
  return s === '' ? null : s;
}

export function getField(obj: unknown, name: string): unknown {
  if (obj == null || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  if (name in rec) return rec[name];
  const lower = name.toLowerCase();
  const key = Object.keys(rec).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : rec[key];
}

export function getString(obj: unknown, name: string): string | null {
  const v = getField(obj, name);
  return v == null ? null : String(v);
}

export function getNumber(obj: unknown, name: string): number | null {
  const v = getField(obj, name);
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function getBool(obj: unknown, name: string): boolean | null {
  const v = getField(obj, name);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return null;
}

export function parseApiDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  let s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T');
  if (s.includes('T') && !/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !shouldStop()) {
      const index = next++;
      await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
}
