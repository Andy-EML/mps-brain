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
      TZ_SCHEDULE: 'Europe/London',
      ADMIN_USERNAME: 'admin',
    });
  });
  it('rejects missing secrets and bad enum values', () => {
    expect(() => loadEnv({ ...base, DRMS_TOKEN: '' })).toThrow();
    expect(() => loadEnv({ ...base, LINK_ERP_ID_FIELD: 'serial' })).toThrow();
    expect(() => loadEnv({ ...base, ADMIN_PASSWORD: 'short' })).toThrow();
  });
});
