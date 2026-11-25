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
    // 'none' until SMS is set up: only demo communities (code on screen) can sign in.
    provider: (env.SMS_PROVIDER ?? (isProd ? '' : 'console')) as 'console' | 'msg91' | 'none' | '',
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
  // How many proxies sit in front of the app and append to X-Forwarded-For: 1 for Container Apps'
  // own ingress, 2 behind Front Door as well. 0 locally. The client address is the entry that many
  // hops back, which a visitor cannot forge.
  trustProxyHops: Number(env.PRAGATI_TRUST_PROXY_HOPS ?? (isProd ? 1 : 0)),
  // Azure Front Door's profile id (its X-Azure-FDID header). When set, requests that did not come
  // through our Front Door are refused, and the client address is read from X-Azure-ClientIP.
  frontDoorId: env.PRAGATI_FRONT_DOOR_ID ?? '',
  // Sign in to PostgreSQL with the app's managed identity instead of a password.
  pgEntra: env.AZURE_PG_ENTRA === '1',
  webDir: env.PRAGATI_WEB_DIR ?? 'dist/web',
  // Ask Pragathi. Without a key the assistant is off everywhere; each community also switches it on.
  ask: {
    apiKey: env.ANTHROPIC_API_KEY ?? '',
    baseUrl: env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    model: env.ASK_MODEL ?? 'claude-haiku-5-5',
    perPersonPerDay: Number(env.ASK_DAILY_LIMIT ?? 25),
    perCommunityPerMonth: Number(env.ASK_MONTHLY_LIMIT ?? 1500),
  },
};

if (isProd) {
  if (config.secret.length < 32) throw new Error('PRAGATI_SECRET must be at least 32 characters');
  if (!config.sms.provider || config.sms.provider === 'console') throw new Error('Set SMS_PROVIDER for production (msg91, or none)');
  if (config.sms.provider === 'msg91' && (!config.sms.msg91AuthKey || !config.sms.msg91TemplateId))
    throw new Error('MSG91_AUTH_KEY and MSG91_TEMPLATE_ID must be set when SMS_PROVIDER is msg91');
}
