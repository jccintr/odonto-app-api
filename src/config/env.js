// Leitura das variáveis de ambiente. Tudo é lido na hora do uso (getters), então os testes podem mudar o process.env.
const str = (name, fallback) => process.env[name] || fallback;

const num = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente ${name} não definida.`);
  return value;
};

export const isProduction = () => process.env.NODE_ENV === 'production';

export const config = {
  get port() { return num('PORT', 3000); },
  get databaseUrl() { return required('DATABASE_URL'); },
  get databaseSsl() { return process.env.DATABASE_SSL === 'true'; },
  get dbPoolMax() { return num('DB_POOL_MAX', 10); },

  // segredos diferentes: o token da plataforma nunca vale como token de clínica e vice-versa
  get jwtSecret() { return required('JWT_SECRET'); },
  get platformJwtSecret() { return required('JWT_SECRET_PLATFORM'); },
  get accessTokenTtl() { return str('ACCESS_TOKEN_TTL', '15m'); },
  get platformTokenTtl() { return str('PLATFORM_TOKEN_TTL', '12h'); },
  get refreshTokenDays() { return num('REFRESH_TOKEN_DAYS', 30); },
  get bcryptRounds() { return num('BCRYPT_ROUNDS', 10); },

  // fuso usado para "hoje" e datas de vencimento (produto brasileiro: horário de Brasília)
  get timezone() { return str('TIMEZONE', 'America/Sao_Paulo'); },

  // documentação interativa em /docs e /openapi.json (DOCS_ENABLED=false desliga)
  get docsEnabled() { return process.env.DOCS_ENABLED !== 'false'; },

  get webUrl() { return str('WEB_URL', 'http://localhost:5173').replace(/\/+$/, ''); },
  get corsOrigins() { return process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : null; },

  get emailVerificationHours() { return num('EMAIL_VERIFICATION_HOURS', 24); },
  get passwordResetMinutes() { return num('PASSWORD_RESET_MINUTES', 60); },
  get tokenResendCooldownSeconds() { return num('TOKEN_RESEND_COOLDOWN_SECONDS', 60); },

  get smtpHost() { return process.env.SMTP_HOST; },
  get smtpUser() { return process.env.SMTP_USER; },
  get smtpPassword() { return process.env.SMTP_PASSWORD; },
  get smtpPort() { return num('SMTP_PORT', 465); },
  get smtpFromName() { return str('SMTP_FROM_NAME', 'OdontoApp'); },
  get smtpFrom() { return str('SMTP_FROM', process.env.SMTP_USER); },
};
