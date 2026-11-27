import { createVantageClient, type VantageClient } from '@mps/vantage';
import { requiredEnv } from './env';

/**
 * The web app's own Vantage client, for the read-only "Search Vantage notes" box. Server only:
 * imported from server actions, never from a client component, so the credentials stay on the
 * server. Built from the same env as the worker's (`VANTAGE_BASE_URL`, `VANTAGE_USER`,
 * `VANTAGE_PASS`, `VANTAGE_API_VERSION`), on first use so `next build` never needs them, and parked
 * on `globalThis` so the session token is reused across requests and hot reloads.
 */
const globalForVantage = globalThis as typeof globalThis & { __mpsVantage?: VantageClient };

export function getVantage(): VantageClient {
  globalForVantage.__mpsVantage ??= createVantageClient({
    baseUrl: requiredEnv('VANTAGE_BASE_URL'),
    username: requiredEnv('VANTAGE_USER'),
    password: requiredEnv('VANTAGE_PASS'),
    apiVersion: optionalApiVersion(),
    // A person is waiting on the answer; the worker's 60 s is too long.
    timeoutMs: 20_000,
  });
  return globalForVantage.__mpsVantage;
}

function optionalApiVersion(): string {
  try {
    return requiredEnv('VANTAGE_API_VERSION');
  } catch {
    return '1.22';
  }
}
