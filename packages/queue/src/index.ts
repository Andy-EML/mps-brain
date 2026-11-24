import PgBoss from 'pg-boss';

export const QUEUES = {
  vantagePull: 'vantage-pull',
  drmsPull: 'drms-pull',
  linkRun: 'link-run',
  drmsSnapshot: 'drms-snapshot',
  drmsAlarms: 'drms-alarms',
  vantageOrders: 'vantage-orders',
  /** Nightly: Vantage meter readings for the last 12 months (feeds the toner-yield meter series). */
  vantageMeters: 'vantage-meters',
  /** Nightly: which contracts each Vantage machine is on, and whether they are active (PM due). */
  vantageContracts: 'vantage-contracts',
  /** Nightly: Vantage work visits for the last 12 months (PM due). */
  vantageWork: 'vantage-work',
  /** Nightly: Vantage engineers (id, name, active) for the PM planner. */
  vantageEngineers: 'vantage-engineers',
  /** Intraday (06:00-19:30): work units scheduled for today and tomorrow, for the PM planner's Upcoming jobs. */
  vantageSchedule: 'vantage-schedule',
  /** Nightly: caches county and centroid per customer postcode district from postcodes.io. */
  postcodeLookup: 'postcode-lookup',
  replenishEvaluate: 'replenish-evaluate',
  /** Nightly: checks Discovered devices and fills the DRMS registration approval queue. */
  drmsRegistrationScan: 'drms-registration-scan',
  /** Registers approved devices in DRMS, one at a time. Queued on approval, plus a 10-minute sweep. */
  drmsRegistrationSubmit: 'drms-registration-submit',
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

/**
 * `sendJob` for several queues over one connection — the Jobs page's "Run all". Returns one entry
 * per queue, in order: the new job's id, or `null` when it was folded into one already queued.
 */
export async function sendJobs(
  connectionString: string,
  queues: readonly QueueName[],
): Promise<Array<{ queue: QueueName; jobId: string | null }>> {
  const boss = createBoss(connectionString, 'client');
  boss.on('error', (err) => console.error('[pg-boss]', err));
  try {
    await boss.start();
    const results: Array<{ queue: QueueName; jobId: string | null }> = [];
    for (const queue of queues) results.push({ queue, jobId: await boss.send(queue, {}) });
    return results;
  } finally {
    await boss.stop({ graceful: false, wait: true });
  }
}
