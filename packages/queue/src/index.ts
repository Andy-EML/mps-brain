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
