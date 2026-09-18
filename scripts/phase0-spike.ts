// Phase 0: read-only discovery. Run: npx tsx --env-file=.env scripts/phase0-spike.ts
import { mkdir, writeFile } from 'node:fs/promises';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};
const OUT = 'fixtures/raw';
await mkdir(OUT, { recursive: true });
const save = (name: string, data: unknown) =>
  writeFile(`${OUT}/${name}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));

// ---------- DRMS ----------
const drmsBase = env('DRMS_BASE_URL').replace(/\/+$/, '');
const drmsToken = env('DRMS_TOKEN');
async function drms(path: string): Promise<unknown> {
  const res = await fetch(`${drmsBase}/${path}`, {
    headers: { Authorization: `Bearer ${drmsToken}`, Accept: 'application/json' },
  });
  const text = await res.text();
  console.log(`DRMS GET ${path} -> ${res.status} (${text.length} bytes)`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const [, payload] = drmsToken.split('.');
if (payload) {
  const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number }).exp;
  console.log('DRMS token exp:', exp ? new Date(exp * 1000).toISOString() : 'none');
}
console.log('Test/Auth:', await drms('Test/Auth'));
console.log('Test/Client:', await drms('Test/Client'));

type Row = Record<string, unknown>;
const page1 = (await drms('Equipment?pageNo=1')) as Row[];
const page0 = (await drms('Equipment?pageNo=0')) as Row[];
await save('drms-equipment-page1.json', page1);
console.log('Equipment page1 count:', Array.isArray(page1) ? page1.length : 'NOT ARRAY');
console.log(
  'pageNo=0 same first Id as pageNo=1?',
  Array.isArray(page0) && Array.isArray(page1) && page0[0]?.Id === page1[0]?.Id,
);
if (!Array.isArray(page1)) process.exit(1);

const statusCounts: Record<string, number> = {};
for (const e of page1) statusCounts[String(e.Status)] = (statusCounts[String(e.Status)] ?? 0) + 1;
console.log('Status counts (page1):', statusCounts);
console.log('Field names on equipment:', Object.keys(page1[0] ?? {}).join(', '));
console.log(
  'Sample ErpId / SerialNumber / CustomerErpId / CustomerName:',
  page1.slice(0, 10).map((e) => [e.ErpId, e.SerialNumber, e.CustomerErpId, e.CustomerName]),
);

const counterNames = new Set<string>();
const registered = page1.filter((e) => String(e.Status).toLowerCase() === 'registered').slice(0, 5);
for (const e of registered) {
  const c = (await drms(`Equipment/${e.Id}/LatestCounters`)) as Row;
  await save(`drms-latestcounters-${e.Id}.json`, c);
  for (const x of (c?.Counters as Row[] | undefined) ?? []) counterNames.add(String(x.Name));
  for (const m of (c?.ModeSizeCounters as Row[] | undefined) ?? [])
    for (const x of (m.Counters as Row[] | undefined) ?? []) counterNames.add(String(x.Name));
}
console.log('Counter names seen:', [...counterNames].sort());

const customers = await drms('Customer?pageNo=1');
await save('drms-customer-page1.json', customers);
console.log('Customer page1 count:', Array.isArray(customers) ? customers.length : 'NOT ARRAY');

// ---------- Vantage ----------
const vBase = env('VANTAGE_BASE_URL').replace(/\/+$/, '');
const apiVersion = env('VANTAGE_API_VERSION');
const basic = Buffer.from(`${env('VANTAGE_USER')}:${env('VANTAGE_PASS')}`).toString('base64');
const loginRes = await fetch(`${vBase}/application/loginsingle`, {
  method: 'POST',
  headers: { authorization: `Basic ${basic}`, 'api-version': apiVersion },
});
const login = (await loginRes.json()) as Row;
console.log('Vantage login', loginRes.status, 'keys:', Object.keys(login).join(', '));
const vToken = String(login.Token ?? login.token);
console.log('TokenExpiryDate:', login.TokenExpiryDate ?? login.tokenExpiryDate);

async function vantage(pathAndQuery: string): Promise<unknown> {
  const res = await fetch(`${vBase}/${pathAndQuery}`, {
    headers: { authorization: `Bearer ${vToken}`, 'api-version': apiVersion },
  });
  const text = await res.text();
  console.log(`Vantage GET ${pathAndQuery} -> ${res.status} (${text.length} bytes)`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
const q = (s: string) => encodeURIComponent(s);

await save('vantage-metadata.xml', await vantage(`$metadata?api-version=${apiVersion}`));
await save('vantage-customer-top5.json', await vantage(`customer?$top=5`));
await save(
  'vantage-equipment-top5.json',
  await vantage(`Equipment?$top=5&$expand=${q('Item,Customer')}`),
);
const big = (await vantage(`Equipment?$top=1000&$count=true&$select=Id`)) as Row;
console.log(
  'Equipment $top=1000 returned',
  Array.isArray(big) ? big.length : (big?.value as unknown[] | undefined)?.length,
  '@odata.count =',
  (big as Row)?.['@odata.count'],
  'response shape:',
  Array.isArray(big) ? 'array' : Object.keys(big ?? {}).join(', '),
);

for (const e of page1.filter((x) => x.SerialNumber).slice(0, 5)) {
  const serial = String(e.SerialNumber).replace(/'/g, "''");
  const match = await vantage(
    `Equipment?$filter=${q(`serialnumber eq '${serial}'`)}&$expand=${q('Customer')}`,
  );
  const rows = (Array.isArray(match) ? match : (match as Row)?.value) as Row[] | undefined;
  console.log('DRMS', { ErpId: e.ErpId, Serial: e.SerialNumber, CustomerErpId: e.CustomerErpId });
  console.log(
    '  Vantage',
    (rows ?? []).map((r) => ({
      Id: r.Id,
      AssetNumber: r.AssetNumber,
      CustomerId: (r.Customer as Row | undefined)?.Id,
      CustomerRef: (r.Customer as Row | undefined)?.Reference,
    })),
  );
}
console.log('Done. Raw files in fixtures/raw (gitignored). Do not commit them.');
