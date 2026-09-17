import { RateLimitError } from '@mps/core';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Per-method pacing + cooldown. DRMS counts limits per method; retrying during a block extends it. */
export class MethodLimiter {
  private readonly nextSlot = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();

  constructor(
    private readonly perMinute: number,
    private readonly cooldownMs: number,
    private readonly clock: Clock = realClock,
  ) {}

  async acquire(method: string): Promise<void> {
    this.checkCooldown(method);
    const now = this.clock.now();
    const slot = Math.max(now, this.nextSlot.get(method) ?? 0);
    this.nextSlot.set(method, slot + 60_000 / this.perMinute);
    if (slot > now) await this.clock.sleep(slot - now);
    // A sibling call may have tripped the cooldown while we were asleep.
    this.checkCooldown(method);
  }

  private checkCooldown(method: string): void {
    const until = this.cooldownUntil.get(method);
    if (until !== undefined && this.clock.now() < until) {
      throw new RateLimitError(`DRMS ${method} is cooling down after a 429`, new Date(until));
    }
  }

  tripCooldown(method: string): Date {
    const until = this.clock.now() + this.cooldownMs;
    this.cooldownUntil.set(method, until);
    return new Date(until);
  }
}
