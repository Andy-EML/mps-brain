import { describe, expect, it } from 'vitest';
import { QUEUES } from '@mps/queue';
import { JOB_CARDS, RUN_ALL_QUEUES, apiName, formatDuration, runTone, statLines, tokenExpiry } from './admin-jobs';

const NOW = new Date('2026-09-18T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe('tokenExpiry', () => {
  it('says nothing is known when the worker has not recorded an expiry', () => {
    const state = tokenExpiry(null, NOW);
    expect(state.tone).toBe('muted');
    expect(state.expiresInDays).toBeNull();
    expect(state.warn).toBe(false);
  });

  it('warns inside the 14-day window', () => {
    const state = tokenExpiry(days(13), NOW);
    expect(state.warn).toBe(true);
    expect(state.tone).toBe('warn');
    expect(state.expiresInDays).toBe(13);
    expect(state.label).toContain('13 days');
  });

  it('treats exactly 14 days as inside the window and 15 as outside', () => {
    expect(tokenExpiry(days(14), NOW).warn).toBe(true);
    expect(tokenExpiry(days(15), NOW).warn).toBe(false);
    expect(tokenExpiry(days(15), NOW).tone).toBe('ok');
  });

  it('is critical once the token has expired', () => {
    const state = tokenExpiry(days(-1), NOW);
    expect(state.expired).toBe(true);
    expect(state.tone).toBe('critical');
    expect(state.warn).toBe(true);
    expect(state.label).toContain('Expired');
  });

  it('does not warn about the QA token, which expires in 2100', () => {
    // The real `app_state.drms_token_expiry` value today. The warning must stay silent for it —
    // that is the point of testing the banding rather than eyeballing the page.
    const state = tokenExpiry(new Date('2100-01-14T23:00:00.000Z'), NOW);
    expect(state.warn).toBe(false);
    expect(state.expired).toBe(false);
    expect(state.tone).toBe('ok');
    expect(state.label).toContain('2100');
  });

  it('accepts the ISO string app_state actually stores', () => {
    expect(tokenExpiry('2026-09-25T00:00:00.000Z', NOW).warn).toBe(true);
    expect(tokenExpiry('not a date', NOW).tone).toBe('muted');
  });
});

describe('formatDuration', () => {
  it('shows sub-second runs in milliseconds and the rest in seconds', () => {
    expect(formatDuration(45)).toBe('45ms');
    expect(formatDuration(480)).toBe('480ms');
    expect(formatDuration(1_500)).toBe('1.5s');
    expect(formatDuration(10_500)).toBe('11s');
  });

  it('breaks a long run into minutes and seconds', () => {
    expect(formatDuration(72_000)).toBe('1m 12s');
    expect(formatDuration(3_600_000)).toBe('60m 0s');
  });

  it('returns null for a run that has not finished', () => {
    expect(formatDuration(null)).toBeNull();
  });
});

describe('runTone', () => {
  it('maps every status the worker writes', () => {
    expect(runTone('success')).toBe('ok');
    expect(runTone('partial')).toBe('warn');
    expect(runTone('failed')).toBe('critical');
    expect(runTone('running')).toBe('muted');
    expect(runTone('something-new')).toBe('muted');
  });
});

describe('statLines', () => {
  it('turns the jobs stats jsonb into readable label/value pairs', () => {
    // The real shape of a link-run's stats, from sync_runs id 3.
    const lines = statLines({
      activeLinks: 830,
      linksClosed: 0,
      issuesOpened: 1001,
      linksCreated: 830,
      customerLinks: 229,
      issuesResolved: 0,
    });

    expect(lines).toContainEqual({ label: 'Active links', value: '830' });
    expect(lines).toContainEqual({ label: 'Issues opened', value: '1,001' });
    expect(lines).toHaveLength(6);
  });

  it('keeps non-numeric values readable and drops nothing', () => {
    expect(statLines({ full: 1, mode: 'delta' })).toEqual([
      { label: 'Full', value: '1' },
      { label: 'Mode', value: 'delta' },
    ]);
  });

  it('is empty for a run with no stats at all', () => {
    expect(statLines({})).toEqual([]);
    expect(statLines(null)).toEqual([]);
    expect(statLines('not an object')).toEqual([]);
  });
});

describe('JOB_CARDS', () => {
  it('covers all nine queues and flags the ones that call an external API', () => {
    expect(JOB_CARDS.map((c) => c.queue)).toEqual([
      'vantage-pull',
      'drms-pull',
      'link-run',
      'drms-snapshot',
      'drms-alarms',
      'vantage-orders',
      'replenish-evaluate',
      'drms-registration-scan',
      'drms-registration-submit',
    ]);
    // link-run and replenish-evaluate are the jobs that stay inside Postgres, so they are the
    // only ones that run without a confirmation.
    expect(JOB_CARDS.filter((c) => !c.external).map((c) => c.queue)).toEqual(['link-run', 'replenish-evaluate']);
  });

  it('names the API each external job calls, and links the registration jobs to their queue', () => {
    const api = Object.fromEntries(JOB_CARDS.filter((c) => c.external).map((c) => [c.queue, apiName(c)]));
    expect(api).toMatchObject({
      'vantage-pull': 'Vantage',
      'drms-pull': 'DRMS',
      // The scan only reads Vantage; the submit job is the one that writes to DRMS.
      'drms-registration-scan': 'Vantage',
      'drms-registration-submit': 'DRMS',
    });
    for (const q of ['drms-registration-scan', 'drms-registration-submit']) {
      expect(JOB_CARDS.find((c) => c.queue === q)?.link).toEqual({ href: '/registrations', label: 'Open DRMS registrations' });
    }
  });
});

describe('RUN_ALL_QUEUES', () => {
  it('queues only jobs that have a card', () => {
    const cards = new Set(JOB_CARDS.map((c) => c.queue));
    for (const queue of RUN_ALL_QUEUES) expect(cards.has(queue)).toBe(true);
  });

  it('leaves out the DRMS writer and the two jobs the worker chains itself', () => {
    expect(RUN_ALL_QUEUES).not.toContain(QUEUES.drmsRegistrationSubmit);
    expect(RUN_ALL_QUEUES).not.toContain(QUEUES.linkRun);
    expect(RUN_ALL_QUEUES).not.toContain(QUEUES.replenishEvaluate);
    expect(RUN_ALL_QUEUES).toHaveLength(JOB_CARDS.length - 3);
  });
});
