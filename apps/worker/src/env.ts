import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DRMS_BASE_URL: z.url(),
  DRMS_TOKEN: z.string().min(1),
  VANTAGE_BASE_URL: z.url(),
  VANTAGE_USER: z.string().min(1),
  VANTAGE_PASS: z.string().min(1),
  VANTAGE_API_VERSION: z.string().min(1).default('1.22'),
  LINK_ERP_ID_FIELD: z.enum(['id', 'assetNumber']).default('id'),
  LINK_CUSTOMER_ERP_FIELD: z.enum(['id', 'reference', 'none']).default('none'),
  SNAPSHOT_CRON: z.string().min(1).default('0 6 * * *'),
  DRMS_PULL_CRON: z.string().min(1).default('15 * * * *'),
  ALARMS_CRON: z.string().min(1).default('*/30 * * * *'),
  /** Sales-order pull; runs after the nightly Vantage pull at 02:00. */
  ORDERS_CRON: z.string().min(1).default('40 2 * * *'),
  OFFLINE_ALERT_HOURS: z.coerce.number().int().positive().default(24),
  TZ_SCHEDULE: z.string().min(1).default('Europe/London'),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(12).optional(),
  /** DRMS registration (approval queue): seconds between registrations — the backbone deadlocks under a stream. */
  AUTO_REGISTER_PAUSE_SECONDS: z.coerce.number().int().min(0).default(90),
  /** DRMS registration: most registrations sent per `drms-registration-submit` run. */
  AUTO_REGISTER_MAX_PER_RUN: z.coerce.number().int().positive().default(40),
  /** DRMS registration: customers never proposed (case-insensitive regex on device + customer name). */
  AUTO_REGISTER_EXCLUDE: z
    .string()
    .min(1)
    .default('tfc group')
    .refine((s) => {
      try {
        new RegExp(s, 'i');
        return true;
      } catch {
        return false;
      }
    }, 'AUTO_REGISTER_EXCLUDE must be a valid regular expression'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(src: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Env {
  const cleaned = Object.fromEntries(Object.entries(src).filter(([, v]) => v !== undefined && v !== ''));
  // Keep explicitly-empty required secrets failing: re-add them as ''.
  for (const key of ['DRMS_TOKEN', 'VANTAGE_USER', 'VANTAGE_PASS', 'DATABASE_URL'] as const) {
    if (src[key] === '') cleaned[key] = '';
  }
  return envSchema.parse(cleaned);
}
