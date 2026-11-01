import { afterEach, describe, expect, it, vi } from 'vitest';
import { rateLimitEnabled, trustProxySetting } from '../src/middlewares/rateLimit.js';
import { sendPasswordResetEmail } from '../src/services/mailer.js';
import { api, createClinic, createUser } from './helpers/factories.js';

afterEach(() => vi.unstubAllEnvs());

describe('rateLimitEnabled', () => {
  it('vem desligado nos testes, ligado fora deles e o RATE_LIMIT_ENABLED manda', () => {
    expect(rateLimitEnabled()).toBe(false);
    for (const [value, expected] of [['true', true], ['1', true], ['false', false], ['0', false]]) {
      vi.stubEnv('RATE_LIMIT_ENABLED', value);
      expect(rateLimitEnabled()).toBe(expected);
    }
    vi.stubEnv('RATE_LIMIT_ENABLED', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect(rateLimitEnabled()).toBe(true);
  });
});

describe('trustProxySetting', () => {
  it.each([
    [{}, false],
    [{ NODE_ENV: 'production' }, 1],
    [{ NODE_ENV: 'production', TRUST_PROXY: 'false' }, false],
    [{ TRUST_PROXY: '' }, false],
    [{ TRUST_PROXY: 'true' }, true],
    [{ TRUST_PROXY: '2' }, 2],
    [{ TRUST_PROXY: 'loopback' }, 'loopback'],
  ])('%j -> %j', (env, expected) => {
    expect(trustProxySetting(env)).toBe(expected);
  });

  it('usa process.env quando não recebe argumento', () => {
    vi.stubEnv('TRUST_PROXY', '3');
    expect(trustProxySetting()).toBe(3);
  });
});

describe('limites por IP (ligados)', () => {
  const on = (env = {}) => {
    vi.stubEnv('RATE_LIMIT_ENABLED', 'true');
    Object.entries(env).forEach(([k, v]) => vi.stubEnv(k, v));
  };
  const badLogin = () => api().post('/api/auth/login').send({ email: 'x@x.com', password: 'errada-errada' });

  it('login: só as tentativas que falham contam, e o excesso responde 429 com Retry-After', async () => {
    on({ RATE_LIMIT_LOGIN_MAX: '2' });
    expect((await badLogin()).status).toBe(401);
    expect((await badLogin()).status).toBe(401);
    const blocked = await badLogin();
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED', error: expect.any(String) });
    expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('login certo não conta no limite', async () => {
    on({ RATE_LIMIT_LOGIN_MAX: '2' });
    const user = await createUser(await createClinic());
    for (let i = 0; i < 4; i += 1) {
      expect((await api().post('/api/auth/login').send({ email: user.email, password: 'senha-segura-123' })).status).toBe(200);
    }
  });

  it('global: limita qualquer rota, menos /health', async () => {
    on({ RATE_LIMIT_GLOBAL_MAX: '3' });
    for (let i = 0; i < 3; i += 1) expect((await api().get('/')).status).toBe(200);
    expect((await api().get('/')).status).toBe(429);
    expect((await api().get('/health')).status).toBe(200);
  });

  it('e-mails de senha e verificação: limite por hora', async () => {
    on({ RATE_LIMIT_PASSWORD_MAX: '2' });
    const forgot = () => api().post('/api/auth/forgot-password').send({ email: 'x@x.com' });
    expect((await forgot()).status).toBe(200);
    expect((await forgot()).status).toBe(200);
    expect((await forgot()).status).toBe(429);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('valor inválido na variável cai no padrão', async () => {
    on({ RATE_LIMIT_LOGIN_MAX: 'abc' });
    for (let i = 0; i < 3; i += 1) expect((await badLogin()).status).toBe(401);
  });
});
