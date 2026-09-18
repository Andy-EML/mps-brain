import PgBoss from 'pg-boss';

export const QUEUES = {
  vantagePull: 'vantage-pull',
  drmsPull: 'drms-pull',
  linkRun: 'link-run',
  drmsSnapshot: 'drms-snapshot',
  drmsAlarms: 'drms-alarms',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** 'client' = send-only (web app): no maintenance or cron supervision. */
export function createBoss(connectionString: string, role: 'worker' | 'client'): PgBoss {
  return role === 'worker'
    ? new PgBoss({ connectionString })
    : new PgBoss({ connectionString, supervise: false, schedule: false });
}

export function isQueueName(value: string): value is QueueName {
  return (Object.values(QUEUES) as string[]).includes(value);
}

/**
 * Queues one job from a send-only client (the web app's "Run now" buttons) and disconnects again.
 *
 * The connection is deliberately per-call rather than a long-lived pool: manual runs are rare, and
 * a parked pg-boss instance in a Next.js server would keep polling and hold a Postgres connection
 * open for the life of the process. `stop()` is in a `finally` so a failed `send` cannot leak one.
 *
 * Returns the new job's id, or `null` when pg-boss deduplicated the send — every queue here uses
 * the `stately` policy, so a second "Run now" while the same job is already queued or running is
 * folded into the first rather than running twice.
 */
export async function sendJob(connectionString: string, queue: QueueName): Promise<string | null> {
  const boss = createBoss(connectionString, 'client');
  // Without a handler, an unhandled 'error' event would take the whole Next.js server down.
  boss.on('error', (err) => console.error('[pg-boss]', err));
  try {
    await boss.start();
    return await boss.send(queue, {});
  } finally {
    await boss.stop({ graceful: false, wait: true });
  }
}
