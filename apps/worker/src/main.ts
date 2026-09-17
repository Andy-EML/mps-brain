import { createDb, ensureAdminUser, setAppState } from '@mps/db';
import { runMigrations } from '@mps/db/migrate';
import { createDrmsClient, decodeJwtExpiry } from '@mps/drms';
import { QUEUES, createBoss, type QueueName } from '@mps/queue';
import { createVantageClient } from '@mps/vantage';
import { loadEnv } from './env';
import { buildHandlers, type JobData } from './handlers';
import { failStaleRuns } from './sync-runs';

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);

  await runMigrations(db);
  const stale = await failStaleRuns(db);
  if (stale > 0) console.warn(`[worker] marked ${stale} stale run(s) as failed`);
  if (env.ADMIN_PASSWORD && (await ensureAdminUser(db, env.ADMIN_USERNAME, env.ADMIN_PASSWORD))) {
    console.log(`[worker] created admin user "${env.ADMIN_USERNAME}"`);
  }
  await setAppState(db, 'drms_token_expiry', decodeJwtExpiry(env.DRMS_TOKEN)?.toISOString() ?? null);

  const drms = createDrmsClient({ baseUrl: env.DRMS_BASE_URL, token: env.DRMS_TOKEN });
  const vantage = createVantageClient({
    baseUrl: env.VANTAGE_BASE_URL,
    username: env.VANTAGE_USER,
    password: env.VANTAGE_PASS,
    apiVersion: env.VANTAGE_API_VERSION,
  });

  const boss = createBoss(env.DATABASE_URL, 'worker');
  boss.on('error', (err) => console.error('[pg-boss]', err));
  await boss.start();

  for (const name of Object.values(QUEUES)) {
    await boss.createQueue(name, { name, policy: 'stately', retryLimit: 0 });
  }
  const tz = env.TZ_SCHEDULE;
  await boss.schedule(QUEUES.vantagePull, '0 2 * * *', {}, { tz });
  await boss.schedule(QUEUES.drmsPull, '15 2 * * *', {}, { tz });
  await boss.schedule(QUEUES.drmsSnapshot, env.SNAPSHOT_CRON, {}, { tz });

  const handlers = buildHandlers({
    db,
    drms,
    vantage,
    linkConfig: { erpIdField: env.LINK_ERP_ID_FIELD, customerErpField: env.LINK_CUSTOMER_ERP_FIELD },
    tz,
    queueLinkRun: () => boss.send(QUEUES.linkRun, {}, { startAfter: 120 }),
  });

  for (const [name, handler] of Object.entries(handlers) as [QueueName, (d: JobData) => Promise<void>][]) {
    await boss.work<JobData>(name, async ([job]) => {
      console.log(`[worker] ${name} started`);
      await handler(job?.data ?? {});
      console.log(`[worker] ${name} finished`);
    });
  }
  console.log('[worker] ready');

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, stopping`);
    await boss.stop({ graceful: true, timeout: 30_000 });
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
