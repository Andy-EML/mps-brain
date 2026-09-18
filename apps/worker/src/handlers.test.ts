import { syncRuns } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import type { DrmsClient } from '@mps/drms';
import type { VantageClient } from '@mps/vantage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHandlers } from './handlers';
import { drmsDevice, fakeVantage } from './test-helpers';

describe('buildHandlers', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  function setup(now: Date) {
    const vantage = fakeVantage([], []);
    let linkRunsQueued = 0;
    const drms = {
      listEquipment: async () => [drmsDevice('g1')],
      listCustomers: async () => [],
      latestCounters: async () => null,
      testAuth: async () => 'Ok',
    } as DrmsClient;
    const handlers = buildHandlers({
      db: t.db,
      drms,
      vantage: vantage.client as unknown as VantageClient,
      linkConfig: { erpIdField: 'id', customerErpField: 'reference' },
      tz: 'Europe/London',
      queueLinkRun: async () => {
        linkRunsQueued++;
      },
      now: () => now,
    });
    return { handlers, vantage, queued: () => linkRunsQueued };
  }

  it('records runs and queues link-run after pulls', async () => {
    const { handlers, queued } = setup(new Date('2026-09-17T02:00:00Z'));
    await handlers['drms-pull']({});
    await handlers['vantage-pull']({});
    await handlers['link-run']({});
    await handlers['drms-snapshot']({});
    expect(queued()).toBe(2);
    const runs = await t.db.select().from(syncRuns).orderBy(syncRuns.id);
    expect(runs.map((r) => [r.job, r.status])).toEqual([
      ['drms-pull', 'success'],
      ['vantage-pull', 'success'],
      ['link-run', 'success'],
      ['drms-snapshot', 'success'],
    ]);
  });

  it('forces a full vantage pull on Sundays (London time)', async () => {
    const { handlers, vantage } = setup(new Date('2026-09-20T01:00:00Z'));
    await t.db.insert(syncRuns).values({ job: 'vantage-pull', status: 'success', startedAt: new Date('2026-09-19T01:00:00Z') });
    await handlers['vantage-pull']({});
    expect(vantage.calls[0]?.opts).toEqual({ includeDeleted: false });
  });
});
