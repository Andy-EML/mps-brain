import { QUEUES, type QueueName } from '@mps/queue';

export interface WorkerQueueOptions {
  name: QueueName;
  policy: 'stately';
  retryLimit: number;
  /** pg-boss defaults to 15 minutes, which is shorter than a real snapshot or pull. */
  expireInSeconds: number;
}

const stately = (name: QueueName, expireInSeconds: number): WorkerQueueOptions => ({
  name,
  policy: 'stately',
  retryLimit: 0,
  expireInSeconds,
});

export const QUEUE_OPTIONS: Record<QueueName, WorkerQueueOptions> = {
  [QUEUES.drmsSnapshot]: stately(QUEUES.drmsSnapshot, 7200),
  [QUEUES.vantagePull]: stately(QUEUES.vantagePull, 3600),
  [QUEUES.drmsPull]: stately(QUEUES.drmsPull, 3600),
  [QUEUES.linkRun]: stately(QUEUES.linkRun, 1800),
  [QUEUES.drmsAlarms]: stately(QUEUES.drmsAlarms, 1800),
};
