import rateLimit, { MemoryStore, ipKeyGenerator, MINUTE, HOUR } from 'express-rate-limit';

// Limite de requisições por IP (em memória, por processo). Freio contra força bruta e spam de e-mail.
// Ajustes por variável de ambiente:
//   RATE_LIMIT_ENABLED=false     desliga tudo (nos testes já vem desligado)
//   RATE_LIMIT_GLOBAL_MAX=1000   qualquer rota, por IP, a cada 15 min
//   RATE_LIMIT_LOGIN_MAX=10      logins que FALHAM, por IP, a cada 15 min (login certo não conta)
//   RATE_LIMIT_PASSWORD_MAX=10   pedidos de e-mail (esqueci a senha, reenvio de verificação), por IP, por hora
// Atrás de proxy (ex.: Railway), o IP real vem de X-Forwarded-For: veja TRUST_PROXY em trustProxySetting().

const num = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const rateLimitEnabled = () => {
  const value = process.env.RATE_LIMIT_ENABLED;
  if (value) return !['false', '0'].includes(value);
  return process.env.NODE_ENV !== 'test';
};

/**
 * Valor para app.set('trust proxy', ...). Em produção o padrão é 1 salto (o proxy da plataforma);
 * fora dela, desligado. TRUST_PROXY manda: número de saltos, "true"/"false" ou lista de sub-redes.
 */
export function trustProxySetting(env = process.env) {
  const raw = env.TRUST_PROXY ?? (env.NODE_ENV === 'production' ? '1' : undefined);
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

const stores = [];

function createLimiter({ windowMs, max, defaultMax, message, skipSuccessfulRequests = false, skipPaths = [] }) {
  const store = new MemoryStore();
  stores.push(store);
  return rateLimit({
    windowMs,
    limit: () => num(max, defaultMax), // lido a cada requisição
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    store,
    skip: (req) => !rateLimitEnabled() || skipPaths.includes(req.path),
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    handler: (req, res) => {
      const retryAfterSeconds = Math.max(1, Math.ceil((req.rateLimit.resetTime.getTime() - Date.now()) / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: message, code: 'RATE_LIMITED', retryAfterSeconds });
    },
  });
}

export const limiters = {
  global: createLimiter({
    windowMs: 15 * MINUTE, max: 'RATE_LIMIT_GLOBAL_MAX', defaultMax: 1000,
    message: 'Muitas requisições. Tente novamente em instantes.', skipPaths: ['/health'],
  }),
  // só tentativas que falham contam: quem acerta a senha nunca é barrado por este limite
  login: createLimiter({
    windowMs: 15 * MINUTE, max: 'RATE_LIMIT_LOGIN_MAX', defaultMax: 10, skipSuccessfulRequests: true,
    message: 'Muitas tentativas de login. Tente novamente mais tarde.',
  }),
  password: createLimiter({
    windowMs: HOUR, max: 'RATE_LIMIT_PASSWORD_MAX', defaultMax: 10,
    message: 'Muitas solicitações. Tente novamente mais tarde.',
  }),
};

/** zera todos os contadores (uso em testes) */
export const resetRateLimits = () => stores.forEach((s) => s.resetAll());
