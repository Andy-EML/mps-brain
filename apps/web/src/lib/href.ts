/** One query param's value: a list repeats the param (`town=a&town=b`). Empty values are dropped. */
export type QueryValue = string | number | null | undefined | readonly string[];
export type QueryParams = Record<string, QueryValue>;

/** Build `/path?a=1&b=2`, dropping empty values so the URL stays clean. */
export function hrefWith(path: string, params: QueryParams): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value as readonly string[]) if (v !== '') qs.append(key, v);
      continue;
    }
    if (value == null || value === '') continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}
