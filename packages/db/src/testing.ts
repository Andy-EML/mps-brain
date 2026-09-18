import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from './client';
import { migrationsFolder } from './migrate';
import {
  counterNames,
  counterSnapshots,
  counterValues,
  deviceAlerts,
  deviceLinks,
  drmsEquipment,
  linkIssues,
  syncRuns,
  users,
  vantageEquipment,
} from './schema';
import * as schema from './schema';

export interface TestDb {
  db: Db;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.close() };
}

export interface DemoFixture {
  /** DRMS ids: `online` is linked with fresh counters, `offline` is linked but stale, `unlinked` has no link. */
  drms: { online: string; offline: string; unlinked: string };
  /** Vantage equipment ids, each actively linked to the matching drms device above. */
  vantage: { linkedToOnline: number; linkedToOffline: number };
  user: { id: number; username: string };
  issues: { unlinkedDrms: number; conflictingCustomer: number };
  /** One open alert (on the offline device) and one cleared, acknowledged alert (on the online device). */
  alerts: { open: number; cleared: number };
  /** One finished/successful sync run and one still running. */
  syncRuns: { success: number; running: number };
}

/**
 * Seeds a small, deterministic fixture shared by the query-layer tests and later web-app tests:
 * 3 DRMS devices (one linked+online, one linked+offline/stale, one unlinked), 2 Vantage equipment
 * rows, two counter snapshots on the online device (so counter-history ordering can be tested),
 * 2 link issues, 2 device alerts (one open, one cleared), 1 user and 2 sync runs.
 *
 * Timestamps are relative to `Date.now()` at seed time (not a fixed calendar date), because the
 * query layer itself compares "offline" and "last sync" against `Date.now()` at query time.
 * Callers that need exact, reproducible values (rather than just consistent relative ordering)
 * should freeze the clock before calling this — e.g. `vi.useFakeTimers({ toFake: ['Date'] })` +
 * `vi.setSystemTime(...)` — so both the fixture's timestamps and the query layer's own `Date.now()`
 * calls resolve against the same frozen instant. See `queries.test.ts` for the pattern.
 */
export async function seedDemoFixture(db: Db): Promise<DemoFixture> {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

  const [user] = await db
    .insert(users)
    .values({ username: 'alice', passwordHash: 'x', role: 'admin', active: true, createdAt: daysAgo(200) })
    .returning({ id: users.id, username: users.username });
  if (!user) throw new Error('seedDemoFixture: failed to insert user');

  await db.insert(drmsEquipment).values([
    {
      drmsId: 'D1',
      erpId: 'E1',
      serial: 'SN0000001',
      serialNorm: 'sn0000001',
      modelName: 'bizhub C3320i',
      productName: 'Acme Office MFP',
      status: 'Registered',
      customerErpId: 'C1',
      customerName: 'Acme Ltd',
      lastCounterReceivedTime: hoursAgo(2),
      raw: {},
    },
    {
      drmsId: 'D2',
      erpId: 'E2',
      serial: 'SN0000002',
      serialNorm: 'sn0000002',
      modelName: 'bizhub C3320i',
      productName: 'Beta Branch MFP',
      status: 'Registered',
      customerErpId: 'C2',
      customerName: 'Beta Co',
      lastCounterReceivedTime: hoursAgo(30),
      raw: {},
    },
    {
      drmsId: 'D3',
      erpId: 'E3',
      serial: 'SN0000003',
      serialNorm: 'sn0000003',
      modelName: 'bizhub C300i',
      productName: 'Gamma Unlinked MFP',
      status: 'Discovered',
      customerErpId: 'C3',
      customerName: 'Gamma Inc',
      lastCounterReceivedTime: null,
      raw: {},
    },
  ]);

  await db.insert(vantageEquipment).values([
    {
      vantageId: 1001,
      serial: 'SN0000001',
      serialNorm: 'sn0000001',
      assetNumber: 'AST-1',
      customerName: 'Acme Ltd (Vantage)',
      vantageCustomerId: 1,
      raw: {},
    },
    {
      vantageId: 1002,
      serial: 'SN0000002',
      serialNorm: 'sn0000002',
      assetNumber: 'AST-2',
      customerName: 'Beta Co (Vantage)',
      vantageCustomerId: 2,
      raw: {},
    },
  ]);

  await db.insert(deviceLinks).values([
    { drmsEquipmentId: 'D1', vantageEquipmentId: 1001, method: 'serial', linkedAt: daysAgo(100) },
    { drmsEquipmentId: 'D2', vantageEquipmentId: 1002, method: 'erp_id', linkedAt: daysAgo(100) },
  ]);

  const [snapOld] = await db
    .insert(counterSnapshots)
    .values({ drmsEquipmentId: 'D1', counterId: 'c0', receivedTime: hoursAgo(26), fetchedAt: hoursAgo(26), raw: {} })
    .returning({ id: counterSnapshots.id });
  if (!snapOld) throw new Error('seedDemoFixture: failed to insert snapshot');
  await db.insert(counterValues).values([
    { snapshotId: snapOld.id, name: 'BlackTonerLevel', value: 10 },
    { snapshotId: snapOld.id, name: 'Black:Total', value: 14000 },
  ]);

  const [snapNew] = await db
    .insert(counterSnapshots)
    .values({ drmsEquipmentId: 'D1', counterId: 'c1', receivedTime: hoursAgo(2), fetchedAt: hoursAgo(2), raw: {} })
    .returning({ id: counterSnapshots.id });
  if (!snapNew) throw new Error('seedDemoFixture: failed to insert snapshot');
  await db.insert(counterValues).values([
    { snapshotId: snapNew.id, name: 'BlackTonerLevel', value: 3 },
    { snapshotId: snapNew.id, name: 'CyanTonerLevel', value: 15 },
    { snapshotId: snapNew.id, name: 'MagentaTonerLevel', value: 60 },
    { snapshotId: snapNew.id, name: 'YellowTonerLevel', value: 70 },
    { snapshotId: snapNew.id, name: 'Black:Total', value: 15000 },
    { snapshotId: snapNew.id, name: 'Full Color:Total', value: 4200 },
    { snapshotId: snapNew.id, name: 'Scanner/FAX:Scan', value: 3000 },
  ]);

  await db.insert(counterNames).values([
    { name: 'BlackTonerLevel', category: 'supply', sampleValue: 3, firstSeen: hoursAgo(26) },
    { name: 'CyanTonerLevel', category: 'supply', sampleValue: 15, firstSeen: hoursAgo(2) },
    { name: 'MagentaTonerLevel', category: 'supply', sampleValue: 60, firstSeen: hoursAgo(2) },
    { name: 'YellowTonerLevel', category: 'supply', sampleValue: 70, firstSeen: hoursAgo(2) },
    { name: 'Black:Total', category: 'meter', sampleValue: 15000, firstSeen: hoursAgo(26) },
    { name: 'Full Color:Total', category: 'meter', sampleValue: 4200, firstSeen: hoursAgo(2) },
    { name: 'Scanner/FAX:Scan', category: 'meter', sampleValue: 3000, firstSeen: hoursAgo(2) },
  ]);

  const [issue1] = await db
    .insert(linkIssues)
    .values({
      issueKey: 'unlinked_drms:D3',
      type: 'unlinked_drms',
      drmsEquipmentId: 'D3',
      vantageEquipmentId: null,
      details: { reason: 'no match' },
      status: 'open',
      firstSeen: daysAgo(5),
      lastSeen: daysAgo(1),
    })
    .returning({ id: linkIssues.id });
  if (!issue1) throw new Error('seedDemoFixture: failed to insert issue');

  const [issue2] = await db
    .insert(linkIssues)
    .values({
      issueKey: 'conflicting_customer:D2:1002',
      type: 'conflicting_customer',
      drmsEquipmentId: 'D2',
      vantageEquipmentId: 1002,
      details: { reason: 'customer mismatch' },
      status: 'open',
      firstSeen: daysAgo(3),
      lastSeen: daysAgo(2),
    })
    .returning({ id: linkIssues.id });
  if (!issue2) throw new Error('seedDemoFixture: failed to insert issue');

  const [alertOpen] = await db
    .insert(deviceAlerts)
    .values({ drmsEquipmentId: 'D2', type: 'SC-541', firstDetectedAt: hoursAgo(10), lastSeenReportAt: hoursAgo(1), details: {} })
    .returning({ id: deviceAlerts.id });
  if (!alertOpen) throw new Error('seedDemoFixture: failed to insert alert');

  const [alertCleared] = await db
    .insert(deviceAlerts)
    .values({
      drmsEquipmentId: 'D1',
      type: 'toner-low',
      firstDetectedAt: hoursAgo(50),
      lastSeenReportAt: hoursAgo(40),
      clearedAt: hoursAgo(30),
      acknowledgedBy: user.id,
      acknowledgedAt: hoursAgo(45),
      details: {},
    })
    .returning({ id: deviceAlerts.id });
  if (!alertCleared) throw new Error('seedDemoFixture: failed to insert alert');

  const [syncSuccess] = await db
    .insert(syncRuns)
    .values({ job: 'drms-pull', status: 'success', startedAt: hoursAgo(1.2), finishedAt: hoursAgo(1), stats: { ok: true } })
    .returning({ id: syncRuns.id });
  if (!syncSuccess) throw new Error('seedDemoFixture: failed to insert sync run');

  const [syncRunning] = await db
    .insert(syncRuns)
    .values({ job: 'vantage-pull', status: 'running', startedAt: hoursAgo(0.1), stats: {} })
    .returning({ id: syncRuns.id });
  if (!syncRunning) throw new Error('seedDemoFixture: failed to insert sync run');

  return {
    drms: { online: 'D1', offline: 'D2', unlinked: 'D3' },
    vantage: { linkedToOnline: 1001, linkedToOffline: 1002 },
    user: { id: user.id, username: user.username },
    issues: { unlinkedDrms: issue1.id, conflictingCustomer: issue2.id },
    alerts: { open: alertOpen.id, cleared: alertCleared.id },
    syncRuns: { success: syncSuccess.id, running: syncRunning.id },
  };
}
