import type { LinkConfig } from '@mps/core';
import type { Db } from '@mps/db';
import type { DrmsClient } from '@mps/drms';
import { QUEUES, type QueueName } from '@mps/queue';
import type { VantageClient } from '@mps/vantage';
import { runDrmsAlarms } from './jobs/drms-alarms';
import { runDrmsPull } from './jobs/drms-pull';
import { runRegistrationScan } from './jobs/drms-registration-scan';
import { runRegistrationSubmit } from './jobs/drms-registration-submit';
import { runDrmsSnapshot } from './jobs/drms-snapshot';
import { runLinkRun } from './jobs/link-run';
import { runReplenishEvaluate } from './jobs/replenish-evaluate';
import { runVantageContracts } from './jobs/vantage-contracts';
import { runVantageMeters } from './jobs/vantage-meters';
import { runPostcodeLookup } from './jobs/postcode-lookup';
import { runVantageEngineers } from './jobs/vantage-engineers';
import { runVantageAlertNotes } from './jobs/vantage-alert-notes';
import { runVantageSchedule } from './jobs/vantage-schedule';
import { runVantageWork } from './jobs/vantage-work';
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
  /** Queues `replenish-evaluate` after the jobs whose data it reads (snapshot, alarms, orders). */
  queueReplenish: () => Promise<unknown>;
  now?: () => Date;
  offlineAlertHours?: number;
  /** postcodes.io base URL (env `POSTCODES_BASE_URL`); defaults to the public API. */
  postcodesBaseUrl?: string;
  /** DRMS registration settings (env `AUTO_REGISTER_*`); the defaults match the env defaults. */
  registration?: { excludeRegex: RegExp; pauseSeconds: number; maxPerRun: number; budgetMs?: number };
}

export type JobData = { full?: boolean };

export function buildHandlers(deps: HandlerDeps): Record<QueueName, (data: JobData) => Promise<void>> {
  const { db, drms, vantage, linkConfig, tz, queueLinkRun, queueReplenish } = deps;
  const now = deps.now ?? (() => new Date());
  const registration = deps.registration ?? { excludeRegex: /tfc group/i, pauseSeconds: 90, maxPerRun: 40 };
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
      await queueReplenish();
    },
    [QUEUES.drmsAlarms]: async () => {
      await withSyncRun(db, QUEUES.drmsAlarms, () => runDrmsAlarms({ db, drms, now }));
      await queueReplenish();
    },
    [QUEUES.vantageOrders]: async () => {
      // Read-only: no link run to queue. Nothing is ever written back to Vantage here — it now
      // queues the replenishment evaluation once the order lines it reads are up to date.
      await withSyncRun(db, QUEUES.vantageOrders, () => runVantageOrders({ db, vantage, now }));
      await queueReplenish();
    },
    [QUEUES.vantageMeters]: async () => {
      // Read-only GETs of Vantage meter readings; nothing to queue afterwards (yield is computed on read).
      await withSyncRun(db, QUEUES.vantageMeters, () => runVantageMeters({ db, vantage, now }));
    },
    [QUEUES.vantageContracts]: async () => {
      // Read-only GETs; the PM due list reads the result on demand.
      await withSyncRun(db, QUEUES.vantageContracts, () => runVantageContracts({ db, vantage, now }));
    },
    [QUEUES.vantageWork]: async () => {
      await withSyncRun(db, QUEUES.vantageWork, () => runVantageWork({ db, vantage, now }));
    },
    [QUEUES.vantageEngineers]: async () => {
      await withSyncRun(db, QUEUES.vantageEngineers, () => runVantageEngineers({ db, vantage, now }));
    },
    [QUEUES.vantageAlertNotes]: async () => {
      // Read-only keyword searches of Vantage notes, one at a time.
      await withSyncRun(db, QUEUES.vantageAlertNotes, () => runVantageAlertNotes({ db, vantage, now }));
    },
    [QUEUES.vantageSchedule]: async () => {
      await withSyncRun(db, QUEUES.vantageSchedule, () => runVantageSchedule({ db, vantage, now }));
    },
    [QUEUES.postcodeLookup]: async () => {
      // The only external call besides Vantage and DRMS: GET postcodes.io/outcodes/{district}.
      await withSyncRun(db, QUEUES.postcodeLookup, () => runPostcodeLookup({ db, baseUrl: deps.postcodesBaseUrl, now }));
    },
    [QUEUES.replenishEvaluate]: async () => {
      await withSyncRun(db, QUEUES.replenishEvaluate, () => runReplenishEvaluate({ db, now }));
    },
    [QUEUES.drmsRegistrationScan]: async () => {
      // Reads our DRMS copy and Vantage (read-only); only fills the approval queue.
      await withSyncRun(db, QUEUES.drmsRegistrationScan, () =>
        runRegistrationScan({ db, vantage, excludeRegex: registration.excludeRegex, now }),
      );
    },
    [QUEUES.drmsRegistrationSubmit]: async () => {
      // The only DRMS write: registers approved devices, one at a time.
      await withSyncRun(db, QUEUES.drmsRegistrationSubmit, () =>
        runRegistrationSubmit({
          db,
          drms,
          now,
          pauseSeconds: registration.pauseSeconds,
          maxPerRun: registration.maxPerRun,
          budgetMs: registration.budgetMs,
        }),
      );
    },
  };
}
