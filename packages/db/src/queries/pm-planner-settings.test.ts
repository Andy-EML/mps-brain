import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, users } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { DEFAULT_PLANNER_SETTINGS, getPlannerSettings, savePlannerSettings, type PlannerSettings } from './pm-planner-settings';
import { SettingsError } from './settings';

describe('planner settings', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  const base = (over: Partial<PlannerSettings> = {}): PlannerSettings => ({ ...DEFAULT_PLANNER_SETTINGS, ...over });
  const rejects = async (s: PlannerSettings) => {
    const err = await savePlannerSettings(t.db, s, null).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as SettingsError).code).toBe('invalid_planner_setting');
  };

  it('has the agreed defaults', () => {
    expect(DEFAULT_PLANNER_SETTINGS).toEqual({
      regionDealers: { ireland: 'MJ Flood', scotland: 'CMYK', channel_islands: 'Sigma' },
      nearMiles: 10,
      doneRetentionDays: 14,
      askedStaleDays: 7,
      patches: [],
    });
  });

  it('returns the defaults when nothing is saved', async () => {
    expect(await getPlannerSettings(t.db)).toEqual(DEFAULT_PLANNER_SETTINGS);
  });

  it('round-trips a saved value, cleaned', async () => {
    await savePlannerSettings(
      t.db,
      base({
        regionDealers: { ireland: '  Acme  ', scotland: '   ', channel_islands: ' Sigma Ltd ' },
        nearMiles: 25,
        doneRetentionDays: 30,
        askedStaleDays: 3,
        patches: [{ name: ' Farnborough ', districts: [' gu14 ', 'GU11', 'gu14'] }],
      }),
      null,
    );
    expect(await getPlannerSettings(t.db)).toEqual({
      regionDealers: { ireland: 'Acme', scotland: null, channel_islands: 'Sigma Ltd' },
      nearMiles: 25,
      doneRetentionDays: 30,
      askedStaleDays: 3,
      patches: [{ name: 'Farnborough', districts: ['GU14', 'GU11'] }],
    });
  });

  it('fills missing keys of an older stored value from the defaults', async () => {
    const { setAppState } = await import('../app-state');
    await setAppState(t.db, 'pm_planner_settings', { nearMiles: 12 });
    expect(await getPlannerSettings(t.db)).toEqual({ ...DEFAULT_PLANNER_SETTINGS, nearMiles: 12 });
  });

  it('gives a saved row without channel_islands the Sigma default, keeping the saved dealers', async () => {
    const { setAppState } = await import('../app-state');
    await setAppState(t.db, 'pm_planner_settings', { regionDealers: { ireland: 'Acme', scotland: null } });
    expect((await getPlannerSettings(t.db)).regionDealers).toEqual({ ireland: 'Acme', scotland: null, channel_islands: 'Sigma' });
  });

  it('writes an audit row with the user id', async () => {
    const [u] = await t.db.insert(users).values({ username: 'sam', passwordHash: 'x', role: 'admin' }).returning({ id: users.id });
    await savePlannerSettings(t.db, base({ nearMiles: 20 }), u!.id);
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, 'pm_planner_settings.update'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(u!.id);
  });

  it.each([0, 101, 1.5, Number.NaN])('rejects nearMiles %s', async (v) => rejects(base({ nearMiles: v })));
  it.each([0, 91, 2.5])('rejects doneRetentionDays %s', async (v) => rejects(base({ doneRetentionDays: v })));
  it.each([0, 61, 0.5])('rejects askedStaleDays %s', async (v) => rejects(base({ askedStaleDays: v })));
  it('accepts the bounds', async () => {
    await savePlannerSettings(t.db, base({ nearMiles: 1, doneRetentionDays: 90, askedStaleDays: 60 }), null);
    await savePlannerSettings(t.db, base({ nearMiles: 100, doneRetentionDays: 1, askedStaleDays: 1 }), null);
  });

  it('rejects a dealer name over 60 characters', async () => {
    await rejects(base({ regionDealers: { ireland: 'x'.repeat(61), scotland: null, channel_islands: null } }));
    await rejects(base({ regionDealers: { ireland: null, scotland: null, channel_islands: 'x'.repeat(61) } }));
  });
  it('rejects a patch with no name, a long name, or a duplicate name (any case)', async () => {
    await rejects(base({ patches: [{ name: '  ', districts: ['GU14'] }] }));
    await rejects(base({ patches: [{ name: 'x'.repeat(41), districts: ['GU14'] }] }));
    await rejects(base({ patches: [{ name: 'North', districts: ['GU14'] }, { name: 'north', districts: ['GU11'] }] }));
  });
  it('rejects a malformed district', async () => {
    for (const bad of ['GU', 'GU145', '14', 'GU14 7PR', '', 'G1A2']) {
      await rejects(base({ patches: [{ name: 'P', districts: [bad] }] }));
    }
  });
  it('accepts one- and two-letter areas and an alphanumeric last character', async () => {
    await savePlannerSettings(t.db, base({ patches: [{ name: 'P', districts: ['G1', 'GU14', 'W1A', 'SW1A'] }] }), null);
  });
  it('rejects the same district in two patches', async () => {
    await rejects(base({ patches: [{ name: 'A', districts: ['GU14', 'GU11'] }, { name: 'B', districts: ['gu11'] }] }));
  });
  it('rejects a non-array patch list', async () => {
    await rejects(base({ patches: 'x' as unknown as PlannerSettings['patches'] }));
  });
});
