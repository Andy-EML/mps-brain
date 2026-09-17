// Phase 0 follow-up probe: read-only. Run: npx tsx --env-file=.env scripts/phase0-probe2.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};
const OUT = 'fixtures/raw';
await mkdir(OUT, { recursive: true });
const save = (name: string, data: unknown) =>
  writeFile(`${OUT}/${name}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));

type Row = Record<string, unknown>;
const norm = (s: unknown) => String(s ?? '').trim().toUpperCase().replace(/[\s-]/g, '');

// ---------- DRMS helpers ----------
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

// ---------- Vantage helpers ----------
const vBase = env('VANTAGE_BASE_URL').replace(/\/+$/, '');
const apiVersion = env('VANTAGE_API_VERSION');
const basic = Buffer.from(`${env('VANTAGE_USER')}:${env('VANTAGE_PASS')}`).toString('base64');
const loginRes = await fetch(`${vBase}/application/loginsingle`, {
  method: 'POST',
  headers: { authorization: `Basic ${basic}`, 'api-version': apiVersion },
});
const login = (await loginRes.json()) as Row;
console.log('Vantage login', loginRes.status);
const vToken = String(login.Token ?? login.token);

const q = (s: string) => encodeURIComponent(s);
async function vantage(pathAndQuery: string): Promise<{ status: number; body: unknown; text: string }> {
  const res = await fetch(`${vBase}/${pathAndQuery}`, {
    headers: { authorization: `Bearer ${vToken}`, 'api-version': apiVersion },
  });
  const text = await res.text();
  console.log(`Vantage GET ${pathAndQuery} -> ${res.status} (${text.length} bytes)`);
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: res.status, body, text };
}
const rowsOf = (b: unknown): Row[] => (Array.isArray(b) ? b : ((b as Row)?.value as Row[] | undefined)) ?? [];

// ---------- load fixture (no new DRMS list call) ----------
const page1 = JSON.parse(await readFile(`${OUT}/drms-equipment-page1.json`, 'utf8')) as Row[];

// ========== Check 1: numeric ErpIds ==========
console.log('\n=== Check 1: numeric ErpId devices ===');
const numericErpIdDevices = page1
  .filter((e) => String(e.Status).toLowerCase() === 'registered' && /^[0-9]+$/.test(String(e.ErpId ?? '')))
  .slice(0, 5);
console.log('numeric-ErpId Registered device count found:', numericErpIdDevices.length);

const check1Results: Row[] = [];
for (const e of numericErpIdDevices) {
  const byId = await vantage(`Equipment(${e.ErpId})?$expand=Customer`);
  const exists = byId.status === 200 && byId.body && Object.keys(byId.body as Row).length > 0;
  const vRow = exists ? (byId.body as Row) : undefined;
  const serialMatches = exists ? norm(vRow?.SerialNumber) === norm(e.SerialNumber) : false;
  console.log('ErpId', e.ErpId, '-> Equipment(id) status', byId.status, 'exists?', exists, 'serialMatches?', serialMatches, 'AssetNumber:', vRow?.AssetNumber);

  const serial = String(e.SerialNumber).replace(/'/g, "''");
  const bySerial = await vantage(`Equipment?$filter=${q(`serialnumber eq '${serial}'`)}`);
  const serialRows = rowsOf(bySerial.body);
  console.log('  by-serial match:', serialRows.map((r) => ({ Id: r.Id, AssetNumber: r.AssetNumber })));

  check1Results.push({
    DrmsErpId: e.ErpId,
    ByIdExists: exists,
    ByIdSerialMatches: serialMatches,
    ByIdAssetNumber: vRow?.AssetNumber ?? null,
    ByIdCustomer: vRow?.Customer ?? null,
    BySerialMatches: serialRows.map((r) => ({ Id: r.Id, AssetNumber: r.AssetNumber })),
    DrmsCustomerErpId: e.CustomerErpId,
  });
}
await save('probe2-check1-numeric-erpid.json', check1Results);

const erpIdEqualsVantageId = check1Results.filter(
  (r) => r.ByIdExists && (r.ByIdSerialMatches || (r.BySerialMatches as Row[]).some((m) => String(m.Id) === String(r.DrmsErpId))),
).length;
const erpIdEqualsAssetNumber = check1Results.filter(
  (r) => (r.BySerialMatches as Row[]).some((m) => String(m.AssetNumber) === String(r.DrmsErpId)),
).length;
console.log('Summary: ErpId==VantageId matches:', erpIdEqualsVantageId, '/', check1Results.length, '| ErpId==AssetNumber matches:', erpIdEqualsAssetNumber, '/', check1Results.length);

// ========== Check 2: customer codes ==========
console.log('\n=== Check 2: CustomerErpId codes ===');
const custCodes = [
  ...new Set(
    page1
      .filter((e) => String(e.Status).toLowerCase() === 'registered' && e.CustomerErpId)
      .map((e) => String(e.CustomerErpId)),
  ),
].slice(0, 5);
console.log('distinct CUST codes sampled:', custCodes.length);

const check2Results: Row[] = [];
for (const code of custCodes) {
  const codeEsc = code.replace(/'/g, "''");
  const byExternal = await vantage(`customer?$filter=${q(`externalaccountnumber eq '${codeEsc}'`)}`);
  if (byExternal.status === 400) console.log('  externalaccountnumber filter 400 body:', byExternal.text.slice(0, 300));
  const byReference = await vantage(`customer?$filter=${q(`reference eq '${codeEsc}'`)}`);
  if (byReference.status === 400) console.log('  reference filter 400 body:', byReference.text.slice(0, 300));
  const extMatches = byExternal.status === 200 ? rowsOf(byExternal.body).length : -1;
  const refMatches = byReference.status === 200 ? rowsOf(byReference.body).length : -1;
  console.log('code (redacted pattern):', code.replace(/[A-Za-z]/g, 'A').replace(/[0-9]/g, '9'), 'externalaccountnumber matches:', extMatches, '(status', byExternal.status, ') reference matches:', refMatches, '(status', byReference.status, ')');
  check2Results.push({ CodePattern: code.replace(/[A-Za-z]/g, 'A').replace(/[0-9]/g, '9'), ExternalStatus: byExternal.status, ExternalMatches: extMatches, ReferenceStatus: byReference.status, ReferenceMatches: refMatches });
}
await save('probe2-check2-customer-codes.json', check2Results);

console.log('\n--- Check 2b: compare check-1 Vantage Customer against DRMS CustomerErpId ---');
const check2b: Row[] = [];
for (const r of check1Results) {
  const cust = r.ByIdCustomer as Row | undefined;
  const ref = cust?.Reference;
  const ext = cust?.ExternalAccountNumber;
  const matchRef = ref != null && String(ref) === String(r.DrmsCustomerErpId);
  const matchExt = ext != null && String(ext) === String(r.DrmsCustomerErpId);
  console.log('DrmsErpId', r.DrmsErpId, 'Customer.Reference match DRMS CustomerErpId?', matchRef, '| Customer.ExternalAccountNumber match?', matchExt);
  check2b.push({ DrmsErpId: r.DrmsErpId, HasCustomer: !!cust, MatchReference: matchRef, MatchExternalAccountNumber: matchExt });
}
await save('probe2-check2b-customer-link.json', check2b);

// ========== Check 3: $metadata ==========
console.log('\n=== Check 3: $metadata ===');
const metaA = await fetch(`${vBase}/$metadata?api-version=1.19`, { headers: { authorization: `Bearer ${vToken}` } });
const metaAText = await metaA.text();
console.log('$metadata?api-version=1.19 ->', metaA.status, `(${metaAText.length} bytes)`);

const metaB = await fetch(`${vBase}/$metadata`, { headers: { authorization: `Bearer ${vToken}`, 'api-version': '1.22' } });
const metaBText = await metaB.text();
console.log('$metadata (header api-version=1.22, no query param) ->', metaB.status, `(${metaBText.length} bytes)`);

let metaXml = '';
if (metaA.status === 200) metaXml = metaAText;
else if (metaB.status === 200) metaXml = metaBText;

if (metaXml) {
  await save('vantage-metadata.xml', metaXml);
  const extractEntity = (xml: string, name: string) => {
    const re = new RegExp(`<EntityType Name="${name}"[\\s\\S]*?<\\/EntityType>`, 'i');
    const m = xml.match(re);
    return m ? m[0] : '';
  };
  const propNames = (block: string) => {
    const names = new Set<string>();
    const re = /<(?:Property|NavigationProperty) Name="([^"]+)"/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(block))) names.add(mm[1]);
    return [...names];
  };
  const eqBlock = extractEntity(metaXml, 'Equipment');
  const custBlock = extractEntity(metaXml, 'Customer');
  const eqProps = propNames(eqBlock);
  const custProps = propNames(custBlock);
  console.log('Equipment entity found:', eqBlock.length > 0, '| property count:', eqProps.length);
  console.log('Customer entity found:', custBlock.length > 0, '| property count:', custProps.length);
  console.log('Equipment fields linking to Customer:', eqProps.filter((n) => /customer/i.test(n)));
  const interesting = (props: string[]) => props.filter((n) => /remote|dca|collection|external/i.test(n));
  console.log('Equipment fields matching Remote/Dca/Collection/External:', interesting(eqProps));
  console.log('Customer fields matching Remote/Dca/Collection/External:', interesting(custProps));
} else {
  console.log('$metadata not retrieved by either attempt; nothing saved/parsed.');
}

// ========== Check 4: Discovered counters ==========
console.log('\n=== Check 4: LatestCounters on Discovered devices ===');
const discovered = page1.filter((e) => String(e.Status).toLowerCase() === 'discovered').slice(0, 3);
console.log('Discovered devices sampled:', discovered.length);
for (const e of discovered) {
  const c = (await drms(`Equipment/${e.Id}/LatestCounters`)) as Row;
  await save(`probe2-discovered-counters-${e.Id}.json`, c);
  const counters = (c?.Counters as Row[] | undefined) ?? [];
  const modeSize = (c?.ModeSizeCounters as Row[] | undefined) ?? [];
  const allNames = [
    ...counters.map((x) => String(x.Name)),
    ...modeSize.flatMap((m) => ((m.Counters as Row[] | undefined) ?? []).map((x) => String(x.Name))),
  ];
  const hasToner = allNames.some((n) => /tonerlevel/i.test(n));
  console.log('Device (status Discovered) Counters non-empty?', counters.length > 0 || modeSize.length > 0, '| any *TonerLevel present?', hasToner, '| total counter names:', allNames.length);
}

console.log('\nDone. Raw files in fixtures/raw (gitignored). Do not commit them.');
