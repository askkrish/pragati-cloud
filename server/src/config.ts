// All settings come from the environment. In Azure they are Container App settings, with secrets
// referenced from Key Vault. Production refuses to start with development defaults.
const env = process.env;
const isProd = env.NODE_ENV === 'production';

function required(name: string, devDefault: string): string {
  const v = env[name];
  if (v) return v;
  if (isProd) throw new Error(`${name} must be set in production`);
  return devDefault;
}

export const config = {
  isProd,
  port: Number(env.PORT ?? 8080),
  host: env.HOST ?? '0.0.0.0',
  appDatabaseUrl: required('DATABASE_URL_APP', 'postgres://pragati_web:pragati-dev-only@localhost:5433/pragati_dev'),
  baseDomain: (env.PRAGATI_BASE_DOMAIN ?? 'localhost').toLowerCase(),
  secret: required('PRAGATI_SECRET', 'dev-secret-not-for-production-use-0000000000'),
  sessionDays: Number(env.PRAGATI_SESSION_DAYS ?? 30),
  idleDays: Number(env.PRAGATI_IDLE_DAYS ?? 7),
  otpTtlSeconds: Number(env.PRAGATI_OTP_TTL ?? 300),
  showOtpInResponse: !isProd && env.PRAGATI_DEV_SHOW_OTP === '1',
  sms: {
    provider: (env.SMS_PROVIDER ?? (isProd ? '' : 'console')) as 'console' | 'msg91' | '',
    msg91AuthKey: env.MSG91_AUTH_KEY ?? '',
    msg91TemplateId: env.MSG91_TEMPLATE_ID ?? '',
  },
  storage: {
    driver: (env.STORAGE_DRIVER ?? (isProd ? 'azure' : 'local')) as 'local' | 'azure',
    localDir: env.STORAGE_LOCAL_DIR ?? 'var/files',
    azureAccount: env.AZURE_STORAGE_ACCOUNT ?? '',
    azureContainer: env.AZURE_STORAGE_CONTAINER ?? 'community-files',
  },
  // Sign-in requests per IP address per minute (codes are also limited per number in the database).
  authRatePerMinute: Number(env.PRAGATI_AUTH_RATE ?? 10),
  maxUploadBytes: Number(env.PRAGATI_MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024),
  trustProxy: env.PRAGATI_TRUST_PROXY === '1' || isProd,
  // Azure Front Door's profile id (its X-Azure-FDID header). When set, requests that did not come
  // through our Front Door are refused, and the client address is read from X-Azure-ClientIP.
  frontDoorId: env.PRAGATI_FRONT_DOOR_ID ?? '',
  // Sign in to PostgreSQL with the app's managed identity instead of a password.
  pgEntra: env.AZURE_PG_ENTRA === '1',
  webDir: env.PRAGATI_WEB_DIR ?? 'dist/web',
};

if (isProd) {
  if (config.secret.length < 32) throw new Error('PRAGATI_SECRET must be at least 32 characters');
  if (!config.sms.provider || config.sms.provider === 'console') throw new Error('Set SMS_PROVIDER for production');
}
