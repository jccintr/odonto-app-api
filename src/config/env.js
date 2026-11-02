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

  // armazenamento de imagens e radiografias (Cloudinary). Sem as três chaves, as rotas de imagem respondem 503.
  get cloudinaryCloudName() { return process.env.CLOUDINARY_CLOUD_NAME; },
  get cloudinaryApiKey() { return process.env.CLOUDINARY_API_KEY; },
  get cloudinaryApiSecret() { return process.env.CLOUDINARY_API_SECRET; },
  get cloudinaryFolder() { return str('CLOUDINARY_FOLDER', 'odontoapp').replace(/^\/+|\/+$/g, ''); },
  // plano gratuito do Cloudinary: imagem de até 10 MB (e 25 megapixels); acima disso o próprio Cloudinary recusa o envio
  get imageMaxMb() { return num('IMAGE_MAX_MB', 10); },
  get imageUrlTtlSeconds() { return num('IMAGE_URL_TTL_SECONDS', 600); },

  // lembretes automáticos de consulta: o agendador roda dentro da API (REMINDERS_SCHEDULER=true), a cada N minutos
  get remindersScheduler() { return process.env.REMINDERS_SCHEDULER === 'true'; },
  get remindersIntervalMinutes() { return num('REMINDERS_INTERVAL_MINUTES', 15); },

  // assinatura da plataforma (cobrança manual por Pix, igual ao Delivroo): teste grátis, carência e suspensão. Tudo calculado por data, sem cron.
  get trialDays() { return num('TRIAL_DAYS', 14); },
  get graceDays() { return num('BILLING_GRACE_DAYS', 7); }, // depois do vencimento: segue usando, com aviso (past_due)
  get cancelAfterDays() { return num('BILLING_CANCEL_AFTER_DAYS', 30); }, // depois da carência: suspensa; passado isto, cancelada
  get invoiceLeadDays() { return num('INVOICE_LEAD_DAYS', 7); }, // a fatura do próximo mês nasce N dias antes de acabar o período
  get billingPixKey() { return process.env.BILLING_PIX_KEY || ''; },
  get billingPixKeyType() { return process.env.BILLING_PIX_KEY_TYPE || null; }, // CPF | CNPJ | PHONE | EMAIL | RANDOM (opcional)
  get billingPixBeneficiary() { return str('BILLING_PIX_BENEFICIARY', 'OdontoApp'); },
  get billingPixCity() { return str('BILLING_PIX_CITY', 'Brazopolis'); },
  get billingPixInstructions() { return process.env.BILLING_PIX_INSTRUCTIONS || ''; },
  // e-mail do dono da plataforma: recebe aviso de clínica nova, "já paguei" e pedido de exclusão. Sem ele, os avisos só vão para o log.
  get ownerEmail() { return process.env.OWNER_EMAIL || ''; },

  // identificação nos Termos de Uso e na Política de Privacidade
  get legalOperatorName() { return str('LEGAL_OPERATOR_NAME', 'OdontoApp'); }, // quem opera a plataforma (nome ou razão social, com CPF/CNPJ se quiser)
  get legalContactEmail() { return process.env.LEGAL_CONTACT_EMAIL || process.env.OWNER_EMAIL || ''; },

  // cadastro público de clínicas
  get signupEnabled() { return process.env.SIGNUP_ENABLED !== 'false'; },
  get signupBlockedDomains() { return (process.env.SIGNUP_BLOCKED_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); },
  get turnstileSecret() { return process.env.TURNSTILE_SECRET || ''; }, // Cloudflare Turnstile (opcional); sem a chave, o captcha fica desligado

  get smtpHost() { return process.env.SMTP_HOST; },
  get smtpUser() { return process.env.SMTP_USER; },
  get smtpPassword() { return process.env.SMTP_PASSWORD; },
  get smtpPort() { return num('SMTP_PORT', 465); },
  get smtpFromName() { return str('SMTP_FROM_NAME', 'OdontoApp'); },
  get smtpFrom() { return str('SMTP_FROM', process.env.SMTP_USER); },
};
