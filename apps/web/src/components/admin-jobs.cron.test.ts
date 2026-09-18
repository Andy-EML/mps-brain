import { describe, expect, it } from 'vitest';

import { JOB_CARDS, cronLabel, scheduleLabel } from './admin-jobs';

describe('cronLabel', () => {
  // The four shapes this project's crons actually take, at the values in use on 2026-09-18.
  it.each([
    ['0 2 * * *', 'Daily at 02:00'],
    ['30 13 * * *', 'Daily at 13:30'],
    ['40 2 * * *', 'Daily at 02:40'],
    ['15 * * * *', 'Hourly, at 15 past'],
    ['0 * * * *', 'Hourly, on the hour'],
    ['*/30 * * * *', 'Every 30 minutes'],
    ['*/5 * * * *', 'Every 5 minutes'],
  ])('reads %s as "%s"', (cron, expected) => {
    expect(cronLabel(cron)).toBe(expected);
  });

  // Anything we cannot phrase is shown as-is: an admin can still see where the job runs, which is
  // the whole point of the line. Silence or a guess would both be worse.
  it.each(['0 3 * * 1', '0 0 1 * *', 'not a cron', '', '* * * * * *'])('falls back to the raw %s', (cron) => {
    expect(cronLabel(cron)).toBe(cron);
  });

  it('rejects out-of-range fields rather than printing nonsense', () => {
    expect(cronLabel('99 2 * * *')).toBe('99 2 * * *');
    expect(cronLabel('0 47 * * *')).toBe('0 47 * * *');
  });
});

describe('scheduleLabel', () => {
  const snapshot = JOB_CARDS.find((c) => c.queue === 'drms-snapshot')!;
  const linkRun = JOB_CARDS.find((c) => c.queue === 'link-run')!;
  const vantagePull = JOB_CARDS.find((c) => c.queue === 'vantage-pull')!;

  it('prefers what the worker registered over the card text', () => {
    // The bug this replaced: the card said 06:00 for months after the job moved to 13:30.
    expect(scheduleLabel(snapshot, new Map([['drms-snapshot', '30 13 * * *']]))).toBe('Daily at 13:30');
  });

  it('keeps the note a cron cannot express', () => {
    expect(scheduleLabel(vantagePull, new Map([['vantage-pull', '0 2 * * *']]))).toBe(
      'Daily at 02:00 (full sync on Sundays)',
    );
  });

  it('falls back to the card text for a job with no cron of its own', () => {
    expect(scheduleLabel(linkRun, new Map())).toBe('After each pull');
  });

  it('falls back when the worker has registered nothing at all', () => {
    expect(scheduleLabel(snapshot, new Map())).toBe(snapshot.schedule);
  });
});
