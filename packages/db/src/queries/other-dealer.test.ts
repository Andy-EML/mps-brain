import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, customerFlags, users, vantageCustomers } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { getOtherDealerControl, loadDealerResolver, setOtherDealer } from './other-dealer';
import { SettingsError } from './settings';

const IE = 1; // Eircode
const IE_COUNTY = 2; // no postcode, Co. Cork
const SCOT = 3;
const ENG = 4;
const HO = 5; // English head office
const HO_SITE_A = 6; // English site of HO
const HO_SITE_B = 7; // Irish site of HO
const BAD_HO = 8; // HeadOfficeId points at a customer that does not exist
const GUERNSEY = 9; // GY postcode
const JERSEY_COUNTY = 10; // no postcode, county Channel Isles

describe('dealer resolver', () => {
  let t: TestDb;
  let userId: number;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(vantageCustomers).values([
      { vantageId: IE, name: 'Dublin Co', raw: { PostCode: 'D04 EK2K' } },
      { vantageId: IE_COUNTY, name: 'Cork Co', raw: { PostCode: '', County: 'Co. Cork' } },
      { vantageId: SCOT, name: 'Edinburgh Co', raw: { PostCode: 'EH1 1YZ' } },
      { vantageId: ENG, name: 'Farnborough Co', raw: { PostCode: 'GU14 7PR', County: 'Hampshire' } },
      { vantageId: HO, name: 'Head Office', raw: { PostCode: 'GU14 7PR' } },
      { vantageId: HO_SITE_A, name: 'HO site A', raw: { PostCode: 'GU51 1AA', HeadOfficeId: HO } },
      { vantageId: HO_SITE_B, name: 'HO site B', raw: { PostCode: 'D04 EK2K', HeadOfficeId: HO } },
      { vantageId: BAD_HO, name: 'Orphan', raw: { PostCode: 'GU14 7PR', HeadOfficeId: 9999 } },
      { vantageId: GUERNSEY, name: 'SPF Guernsey', raw: { PostCode: 'GY1 1AA' } },
      { vantageId: JERSEY_COUNTY, name: 'SPF Jersey', raw: { PostCode: '', County: 'Channel Isles' } },
    ]);
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning({ id: users.id });
    userId = u!.id;
  });
  afterEach(() => t.close());

  const resolve = async (id: number | null) => (await loadDealerResolver(t.db))(id);

  it('resolves Irish and Scottish sites by region and English ones to ours', async () => {
    const r = await loadDealerResolver(t.db);
    expect(r(IE)).toEqual({ dealer: 'MJ Flood', source: 'region', region: 'ireland' });
    expect(r(IE_COUNTY)).toEqual({ dealer: 'MJ Flood', source: 'region', region: 'ireland' });
    expect(r(SCOT)).toEqual({ dealer: 'CMYK', source: 'region', region: 'scotland' });
    expect(r(ENG)).toEqual({ dealer: null, source: null, region: null });
  });

  it('resolves Channel Islands sites (GY postcode, or county Channel Isles) to Sigma by region', async () => {
    const r = await loadDealerResolver(t.db);
    expect(r(GUERNSEY)).toEqual({ dealer: 'Sigma', source: 'region', region: 'channel_islands' });
    expect(r(JERSEY_COUNTY)).toEqual({ dealer: 'Sigma', source: 'region', region: 'channel_islands' });
  });

  it('a unknown or null customer id is ours and never throws', async () => {
    const r = await loadDealerResolver(t.db);
    expect(r(null)).toEqual({ dealer: null, source: null, region: null });
    expect(r(424242)).toEqual({ dealer: null, source: null, region: null });
    expect(r(BAD_HO).dealer).toBeNull();
  });

  it('a site dealer is source site and wins over the region', async () => {
    await setOtherDealer(t.db, { vantageCustomerId: ENG, mode: 'dealer', name: '  Acme Print ', userId });
    expect(await resolve(ENG)).toEqual({ dealer: 'Acme Print', source: 'site', region: null });
    await setOtherDealer(t.db, { vantageCustomerId: IE, mode: 'dealer', name: 'Acme Print', userId });
    expect(await resolve(IE)).toEqual({ dealer: 'Acme Print', source: 'site', region: 'ireland' });
  });

  it('ours undoes the region rule, and default returns to it', async () => {
    await setOtherDealer(t.db, { vantageCustomerId: IE, mode: 'ours', userId });
    expect(await resolve(IE)).toEqual({ dealer: null, source: 'site', region: 'ireland' });
    await setOtherDealer(t.db, { vantageCustomerId: IE, mode: 'default', userId });
    expect(await resolve(IE)).toEqual({ dealer: 'MJ Flood', source: 'region', region: 'ireland' });
    const [row] = await t.db.select().from(customerFlags).where(eq(customerFlags.vantageCustomerId, IE));
    expect(row!.otherDealerOverride).toBeNull();
    expect(row!.otherDealerName).toBeNull();
  });

  it('a head-office dealer covers its sites; a site marked ours stays ours', async () => {
    await setOtherDealer(t.db, { vantageCustomerId: HO, mode: 'dealer', name: 'Acme Print', userId });
    await setOtherDealer(t.db, { vantageCustomerId: HO_SITE_A, mode: 'ours', userId });
    const r = await loadDealerResolver(t.db);
    expect(r(HO)).toEqual({ dealer: 'Acme Print', source: 'site', region: null });
    expect(r(HO_SITE_A)).toEqual({ dealer: null, source: 'site', region: null });
    // The Irish sibling follows the head office, not the region.
    expect(r(HO_SITE_B)).toEqual({ dealer: 'Acme Print', source: 'head_office', region: 'ireland' });
  });

  it('a head-office ours beats the region for its Irish site', async () => {
    await setOtherDealer(t.db, { vantageCustomerId: HO, mode: 'ours', userId });
    expect(await resolve(HO_SITE_B)).toEqual({ dealer: null, source: 'head_office', region: 'ireland' });
  });

  it('region dealer names come from the planner settings; a blank one is ours', async () => {
    const { savePlannerSettings, DEFAULT_PLANNER_SETTINGS } = await import('./pm-planner-settings');
    await savePlannerSettings(t.db, { ...DEFAULT_PLANNER_SETTINGS, regionDealers: { ireland: 'Flood Ltd', scotland: null, channel_islands: null } }, null);
    const r = await loadDealerResolver(t.db);
    expect(r(IE).dealer).toBe('Flood Ltd');
    expect(r(SCOT)).toEqual({ dealer: null, source: null, region: 'scotland' });
  });

  it('getOtherDealerControl gives the device page its props: region default, own flag, head office, suggestions', async () => {
    const g = await getOtherDealerControl(t.db, GUERNSEY);
    expect(g).toEqual({
      customerName: 'SPF Guernsey',
      ownOverride: null,
      ownDealerName: null,
      effective: { dealer: 'Sigma', source: 'region', region: 'channel_islands' },
      defaultInfo: { dealer: 'Sigma', source: 'region', region: 'channel_islands' },
      suggestions: ['MJ Flood', 'CMYK', 'Sigma'],
      isHeadOffice: false,
    });
    await setOtherDealer(t.db, { vantageCustomerId: GUERNSEY, mode: 'ours', userId });
    expect(await getOtherDealerControl(t.db, GUERNSEY)).toMatchObject({
      ownOverride: 'ours',
      ownDealerName: null,
      effective: { dealer: null, source: 'site' },
      defaultInfo: { dealer: 'Sigma', source: 'region' },
    });
    await setOtherDealer(t.db, { vantageCustomerId: HO, mode: 'dealer', name: 'Acme Print', userId });
    expect(await getOtherDealerControl(t.db, HO)).toMatchObject({ ownOverride: 'dealer', ownDealerName: 'Acme Print', isHeadOffice: true });
    expect(await getOtherDealerControl(t.db, HO_SITE_B)).toMatchObject({
      effective: { dealer: 'Acme Print', source: 'head_office' },
      defaultInfo: { dealer: 'Acme Print', source: 'head_office' },
      isHeadOffice: false,
    });
  });

  it('getOtherDealerControl is null for an unknown customer', async () => {
    expect(await getOtherDealerControl(t.db, 424242)).toBeNull();
  });

  it('setOtherDealer leaves self-managed alone and writes an audit row with the user id', async () => {
    await t.db.insert(customerFlags).values({ vantageCustomerId: ENG, selfManaged: true, selfManagedNote: 'n' });
    await setOtherDealer(t.db, { vantageCustomerId: ENG, mode: 'dealer', name: 'Acme Print', userId });
    const [row] = await t.db.select().from(customerFlags).where(eq(customerFlags.vantageCustomerId, ENG));
    expect(row).toMatchObject({ selfManaged: true, selfManagedNote: 'n', otherDealerOverride: 'dealer', otherDealerName: 'Acme Print', updatedBy: userId });
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, 'customer.other_dealer.set'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ userId, entity: 'customer', entityIds: [ENG] });
  });

  it('a dealer needs a name of at most 60 characters', async () => {
    for (const name of [undefined, null, '   ', 'x'.repeat(61)]) {
      const err = await setOtherDealer(t.db, { vantageCustomerId: ENG, mode: 'dealer', name, userId }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SettingsError);
      expect((err as SettingsError).code).toBe('invalid_other_dealer');
    }
  });
});
