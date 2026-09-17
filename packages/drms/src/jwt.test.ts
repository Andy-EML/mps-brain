import { describe, expect, it } from 'vitest';
import { decodeJwtExpiry } from './jwt';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('decodeJwtExpiry', () => {
  it('reads exp seconds', () => {
    const token = `${b64({ alg: 'none' })}.${b64({ exp: 1_800_000_000 })}.sig`;
    expect(decodeJwtExpiry(token)?.toISOString()).toBe('2027-01-15T08:00:00.000Z');
  });
  it('returns null without exp or for junk', () => {
    expect(decodeJwtExpiry(`${b64({})}.${b64({ sub: 'x' })}.sig`)).toBeNull();
    expect(decodeJwtExpiry('not-a-jwt')).toBeNull();
    expect(decodeJwtExpiry('a.%%%.c')).toBeNull();
  });
});
