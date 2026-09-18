import { describe, expect, it } from 'vitest';
import { ApiError, AuthError, ErrorCollector, RateLimitError, errorMessage } from './errors';

describe('errors', () => {
  it('keeps subclass identity and status', () => {
    const err = new AuthError('nope', 401);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.name).toBe('AuthError');
    expect(err.status).toBe(401);
  });
  it('RateLimitError carries retryAt and 429', () => {
    const at = new Date('2026-01-01T00:10:00Z');
    const err = new RateLimitError('slow down', at);
    expect(err.status).toBe(429);
    expect(err.retryAt).toBe(at);
  });
  it('errorMessage formats errors and non-errors', () => {
    expect(errorMessage(new AuthError('bad', 401))).toBe('AuthError: bad');
    expect(errorMessage('plain')).toBe('plain');
  });
  it('ErrorCollector counts all and samples first five', () => {
    const c = new ErrorCollector();
    expect(c.sample).toBeUndefined();
    for (let i = 0; i < 7; i++) c.add(`dev${i}`, new Error(`e${i}`));
    expect(c.count).toBe(7);
    expect(c.sample?.split('\n')).toHaveLength(5);
    expect(c.sample).toContain('dev0: Error: e0');
  });
});
