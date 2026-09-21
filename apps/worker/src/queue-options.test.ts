import { QUEUES } from '@mps/queue';
import { describe, expect, it } from 'vitest';
import { QUEUE_OPTIONS } from './queue-options';

describe('QUEUE_OPTIONS', () => {
  it('sets per-queue expiry above the pg-boss 15-minute default, stately with no retries', () => {
    expect(QUEUE_OPTIONS).toEqual({
      [QUEUES.drmsSnapshot]: { name: 'drms-snapshot', policy: 'stately', retryLimit: 0, expireInSeconds: 7200 },
      [QUEUES.vantagePull]: { name: 'vantage-pull', policy: 'stately', retryLimit: 0, expireInSeconds: 3600 },
      [QUEUES.drmsPull]: { name: 'drms-pull', policy: 'stately', retryLimit: 0, expireInSeconds: 3600 },
      [QUEUES.linkRun]: { name: 'link-run', policy: 'stately', retryLimit: 0, expireInSeconds: 1800 },
      [QUEUES.drmsAlarms]: { name: 'drms-alarms', policy: 'stately', retryLimit: 0, expireInSeconds: 1800 },
      [QUEUES.vantageOrders]: { name: 'vantage-orders', policy: 'stately', retryLimit: 0, expireInSeconds: 3600 },
      [QUEUES.replenishEvaluate]: { name: 'replenish-evaluate', policy: 'stately', retryLimit: 0, expireInSeconds: 1800 },
      [QUEUES.drmsRegistrationScan]: { name: 'drms-registration-scan', policy: 'stately', retryLimit: 0, expireInSeconds: 3600 },
      // Up to 40 registrations with a 90 s pause and a poll each: hours, not minutes.
      [QUEUES.drmsRegistrationSubmit]: { name: 'drms-registration-submit', policy: 'stately', retryLimit: 0, expireInSeconds: 6 * 3600 },
    });
  });
});
