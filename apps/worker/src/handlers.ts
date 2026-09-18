import type { LinkConfig } from '@mps/core';
import type { Db } from '@mps/db';
import type { DrmsClient } from '@mps/drms';
import { QUEUES, type QueueName } from '@mps/queue';
import type { VantageClient } from '@mps/vantage';
import { runDrmsAlarms } from './jobs/drms-alarms';
import { runDrmsPull } from './jobs/drms-pull';
import { runDrmsSnapshot } from './jobs/drms-snapshot';
import { runLinkRun } from './jobs/link-run';
import { runVantageOrders } from './jobs/vantage-orders';
import { runVantagePull } from './jobs/vantage-pull';
import { withSyncRun } from './sync-runs';
import { isSundayIn } from './time';

export interface HandlerDeps {
  db: Db;
  drms: DrmsClient;
  vantage: VantageClient;
  linkConfig: LinkConfig;
  tz: string;
  queueLinkRun: () => Promise<unknown>;
  now?: () => Date;
  offlineAlertHours?: number;
}

export type JobData = { full?: boolean };

export function buildHandlers(deps: HandlerDeps): Record<QueueName, (data: JobData) => Promise<void>> {
  const { db, drms, vantage, linkConfig, tz, queueLinkRun } = deps;
  const now = deps.now ?? (() => new Date());
  return {
    [QUEUES.vantagePull]: async (data) => {
      const full = data.full === true || isSundayIn(tz, now());
      await withSyncRun(db, QUEUES.vantagePull, () => runVantagePull({ db, vantage, now }, { full }));
      await queueLinkRun();
    },
    [QUEUES.drmsPull]: async () => {
      await withSyncRun(db, QUEUES.drmsPull, () =>
        runDrmsPull({ db, drms, now, thresholdHours: deps.offlineAlertHours }),
      );
      await queueLinkRun();
    },
    [QUEUES.linkRun]: async () => {
      await withSyncRun(db, QUEUES.linkRun, () => runLinkRun({ db, config: linkConfig, now }));
    },
    [QUEUES.drmsSnapshot]: async () => {
      await withSyncRun(db, QUEUES.drmsSnapshot, () => runDrmsSnapshot({ db, drms, now }));
    },
    [QUEUES.drmsAlarms]: async () => {
      await withSyncRun(db, QUEUES.drmsAlarms, () => runDrmsAlarms({ db, drms, now }));
    },
    [QUEUES.vantageOrders]: async () => {
      // Read-only: no link run to queue, and nothing is ever written back to Vantage.
      await withSyncRun(db, QUEUES.vantageOrders, () => runVantageOrders({ db, vantage, now }));
    },
  };
}
