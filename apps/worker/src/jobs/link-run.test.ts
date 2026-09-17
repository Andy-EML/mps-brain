import type { LinkConfig } from '@mps/core';
import { customerLinks, deviceLinks, drmsEquipment, linkIssues } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDrms, seedVantage } from '../test-helpers';
import { runLinkRun } from './link-run';

const config: LinkConfig = { erpIdField: 'id', customerErpField: 'reference' };

describe('runLinkRun', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  const activeLinks = () => t.db.select().from(deviceLinks).where(isNull(deviceLinks.unlinkedAt));
  const openIssues = () => t.db.select().from(linkIssues).where(eq(linkIssues.status, 'open'));

  it('creates links and is idempotent', async () => {
    await seedVantage(t.db, [{ vantageId: 10, serial: 'A1B2C3D4E', vantageCustomerId: 1, customerReference: 'CUST1' }]);
    await seedDrms(t.db, [{ drmsId: 'd1', serial: 'a1b2-c3d4e', customerErpId: 'CUST1' }]);

    const first = await runLinkRun({ db: t.db, config });
    expect(first.stats).toMatchObject({ linksCreated: 1, linksClosed: 0, activeLinks: 1, customerLinks: 1 });
    expect(await activeLinks()).toMatchObject([{ drmsEquipmentId: 'd1', vantageEquipmentId: 10, method: 'serial' }]);
    expect(await t.db.select().from(customerLinks)).toMatchObject([{ customerErpId: 'CUST1', vantageCustomerId: 1, method: 'derived', deviceCount: 1 }]);

    const second = await runLinkRun({ db: t.db, config });
    expect(second.stats).toMatchObject({ linksCreated: 0, linksClosed: 0, issuesOpened: 0 });
    expect(await t.db.select().from(deviceLinks)).toHaveLength(1);
  });

  it('keeps manual links and does not overwrite manual customer links', async () => {
    await seedVantage(t.db, [
      { vantageId: 10, serial: 'A1', vantageCustomerId: 1 },
      { vantageId: 20, vantageCustomerId: 2 },
    ]);
    await seedDrms(t.db, [{ drmsId: 'd1', serial: 'A1', customerErpId: 'CUST1' }]);
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd1', vantageEquipmentId: 20, method: 'manual' });
    await t.db.insert(customerLinks).values({ customerErpId: 'CUST1', vantageCustomerId: 99, method: 'manual' });

    await runLinkRun({ db: t.db, config });
    expect(await activeLinks()).toMatchObject([{ vantageEquipmentId: 20, method: 'manual' }]);
    expect(await t.db.select().from(customerLinks)).toMatchObject([{ vantageCustomerId: 99, method: 'manual' }]);
    expect((await openIssues()).map((i) => i.issueKey)).toEqual(['no_match_vantage||10']);
  });

  it('opens issues and auto-resolves them when fixed', async () => {
    await seedDrms(t.db, [{ drmsId: 'd2', serial: 'ZZ9' }]);
    await runLinkRun({ db: t.db, config });
    expect((await openIssues()).map((i) => i.issueKey)).toEqual(['no_match_drms|d2|']);

    await seedVantage(t.db, [{ vantageId: 30, serial: 'zz-9' }]);
    const result = await runLinkRun({ db: t.db, config });
    expect(result.stats).toMatchObject({ linksCreated: 1, issuesResolved: 1 });
    expect(await openIssues()).toEqual([]);
    const [resolved] = await t.db.select().from(linkIssues);
    expect(resolved).toMatchObject({ status: 'resolved' });
    expect(resolved?.resolvedAt).toBeInstanceOf(Date);
  });

  it('leaves ignored issues ignored and reopens resolved ones', async () => {
    await seedDrms(t.db, [{ drmsId: 'd3', serial: 'Q1' }]);
    await runLinkRun({ db: t.db, config });
    await t.db.update(linkIssues).set({ status: 'ignored' });
    await runLinkRun({ db: t.db, config });
    expect((await t.db.select().from(linkIssues))[0]?.status).toBe('ignored');

    await t.db.update(linkIssues).set({ status: 'resolved' });
    const result = await runLinkRun({ db: t.db, config });
    expect(result.stats.issuesOpened).toBe(1);
    expect((await t.db.select().from(linkIssues))[0]?.status).toBe('open');
  });

  it('closes a link when the DRMS device goes missing', async () => {
    await seedVantage(t.db, [{ vantageId: 10, serial: 'A1' }]);
    await seedDrms(t.db, [{ drmsId: 'd1', serial: 'A1' }]);
    await runLinkRun({ db: t.db, config });
    await t.db.update(drmsEquipment).set({ missingSince: new Date() });

    const result = await runLinkRun({ db: t.db, config });
    expect(result.stats).toMatchObject({ linksClosed: 1, activeLinks: 0 });
    const [closed] = await t.db.select().from(deviceLinks);
    expect(closed).toMatchObject({ unlinkedReason: 'auto' });
    expect((await openIssues()).map((i) => i.type).sort()).toEqual(['link_broken', 'no_match_vantage']);
  });

  it('keeps link_broken open across later runs until an operator resolves it', async () => {
    await seedVantage(t.db, [{ vantageId: 10, serial: 'A1' }]);
    await seedDrms(t.db, [{ drmsId: 'd1', serial: 'A1' }]);
    await runLinkRun({ db: t.db, config });
    await t.db.update(drmsEquipment).set({ missingSince: new Date() });

    for (let i = 0; i < 3; i++) await runLinkRun({ db: t.db, config });
    const broken = (await openIssues()).filter((i) => i.type === 'link_broken');
    expect(broken).toMatchObject([{ issueKey: 'link_broken|d1|10', status: 'open' }]);
  });
});
