import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const base = {
  DATABASE_URL: 'postgres://x',
  DRMS_BASE_URL: 'https://drms.test/api/v8',
  DRMS_TOKEN: 't',
  VANTAGE_BASE_URL: 'https://api.vantage.online',
  VANTAGE_USER: 'u',
  VANTAGE_PASS: 'p',
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({
      VANTAGE_API_VERSION: '1.22',
      LINK_ERP_ID_FIELD: 'id',
      LINK_CUSTOMER_ERP_FIELD: 'none',
      SNAPSHOT_CRON: '0 6 * * *',
      DRMS_PULL_CRON: '15 * * * *',
      ALARMS_CRON: '*/30 * * * *',
      ORDERS_CRON: '20 * * * *',
      OFFLINE_ALERT_HOURS: 24,
      TZ_SCHEDULE: 'Europe/London',
      ADMIN_USERNAME: 'admin',
      AUTO_REGISTER_PAUSE_SECONDS: 90,
      AUTO_REGISTER_MAX_PER_RUN: 40,
      AUTO_REGISTER_EXCLUDE: 'tfc group',
    });
    expect(env).not.toHaveProperty('DRMS_AUTO_REGISTER_ENABLED');
  });
  it('reads the registration settings and rejects an exclusion that is not a valid regex', () => {
    expect(loadEnv({ ...base, AUTO_REGISTER_PAUSE_SECONDS: '120', AUTO_REGISTER_MAX_PER_RUN: '5', AUTO_REGISTER_EXCLUDE: 'tfc group|acme' })).toMatchObject({
      AUTO_REGISTER_PAUSE_SECONDS: 120,
      AUTO_REGISTER_MAX_PER_RUN: 5,
      AUTO_REGISTER_EXCLUDE: 'tfc group|acme',
    });
    expect(() => loadEnv({ ...base, AUTO_REGISTER_EXCLUDE: '(' })).toThrow();
    expect(() => loadEnv({ ...base, AUTO_REGISTER_MAX_PER_RUN: '0' })).toThrow();
  });
  it('rejects missing secrets and bad enum values', () => {
    expect(() => loadEnv({ ...base, DRMS_TOKEN: '' })).toThrow();
    expect(() => loadEnv({ ...base, LINK_ERP_ID_FIELD: 'serial' })).toThrow();
    expect(() => loadEnv({ ...base, ADMIN_PASSWORD: 'short' })).toThrow();
  });
});
