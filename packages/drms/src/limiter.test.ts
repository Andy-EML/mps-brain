import { RateLimitError } from '@mps/core';
import { describe, expect, it } from 'vitest';
import { MethodLimiter, type Clock } from './limiter';

function fakeClock(): Clock & { t: number; slept: number[] } {
  return {
    t: 0,
    slept: [],
    now() {
      return this.t;
    },
    async sleep(ms: number) {
      this.slept.push(ms);
      this.t += ms;
    },
  };
}

describe('MethodLimiter', () => {
  it('spaces calls per method at 60000/perMinute ms', async () => {
    const clock = fakeClock();
    const limiter = new MethodLimiter(1000, 600_000, clock);
    await limiter.acquire('Equipment');
    await limiter.acquire('Equipment');
    await limiter.acquire('Equipment');
    await limiter.acquire('Customer');
    expect(clock.slept).toEqual([60, 60]);
  });

  it('refuses calls during cooldown, then allows them after', async () => {
    const clock = fakeClock();
    const limiter = new MethodLimiter(1000, 600_000, clock);
    const until = limiter.tripCooldown('LatestCounters');
    expect(until.getTime()).toBe(600_000);
    await expect(limiter.acquire('LatestCounters')).rejects.toBeInstanceOf(RateLimitError);
    await expect(limiter.acquire('Equipment')).resolves.toBeUndefined();
    clock.t = 600_001;
    await expect(limiter.acquire('LatestCounters')).resolves.toBeUndefined();
  });
});
