import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, isProduction, required } from '../src/config/env.js';
import { buildKnexConfig } from '../src/db/config.js';
import { hashPassword, verifyPassword } from '../src/services/password.js';
import { generateOpaqueToken, hashToken, signAccessToken, verifyAccessToken } from '../src/services/tokens.js';
import { toClinicDto, toPlatformAdminDto, toUserDto } from '../src/utils/dto.js';
import { badRequest, conflict, emailNotVerified, forbidden, HttpError, notFound, tooManyRequests, unauthorized } from '../src/utils/errors.js';
import { createLoginThrottle } from '../src/utils/loginThrottle.js';
import { escapeLike, pageResult, paginate } from '../src/utils/pagination.js';
import { issuedBeforePasswordChange } from '../src/utils/session.js';
import { slugify } from '../src/utils/slug.js';

afterEach(() => vi.unstubAllEnvs());

describe('config/env', () => {
  it('required devolve o valor ou lança se faltar', () => {
    vi.stubEnv('MINHA_VAR', 'valor');
    expect(required('MINHA_VAR')).toBe('valor');
    vi.stubEnv('MINHA_VAR', '');
    expect(() => required('MINHA_VAR')).toThrow('MINHA_VAR não definida');
  });

  it('isProduction', () => {
    expect(isProduction()).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    expect(isProduction()).toBe(true);
  });

  it('usa os padrões quando a variável não existe', () => {
    for (const name of ['PORT', 'DB_POOL_MAX', 'ACCESS_TOKEN_TTL', 'PLATFORM_TOKEN_TTL', 'REFRESH_TOKEN_DAYS', 'BCRYPT_ROUNDS', 'WEB_URL',
      'CORS_ORIGINS', 'EMAIL_VERIFICATION_HOURS', 'PASSWORD_RESET_MINUTES', 'TOKEN_RESEND_COOLDOWN_SECONDS', 'SMTP_PORT', 'SMTP_FROM_NAME',
      'SMTP_FROM', 'SMTP_USER', 'DATABASE_SSL']) vi.stubEnv(name, undefined);
    expect(config).toMatchObject({
      port: 3000, dbPoolMax: 10, accessTokenTtl: '15m', platformTokenTtl: '12h', refreshTokenDays: 30, bcryptRounds: 10,
      webUrl: 'http://localhost:5173', corsOrigins: null, emailVerificationHours: 24, passwordResetMinutes: 60,
      tokenResendCooldownSeconds: 60, smtpPort: 465, smtpFromName: 'OdontoApp', smtpFrom: undefined, databaseSsl: false,
    });
  });

  it('usa o valor da variável quando existe e é válido', () => {
    vi.stubEnv('PORT', '8080');
    vi.stubEnv('WEB_URL', 'https://app.odonto.com.br///');
    vi.stubEnv('CORS_ORIGINS', ' https://a.com , https://b.com ,, ');
    vi.stubEnv('SMTP_USER', 'contato@odonto.com.br');
    vi.stubEnv('SMTP_FROM', 'envio@odonto.com.br');
    vi.stubEnv('DATABASE_SSL', 'true');
    expect(config.port).toBe(8080);
    expect(config.webUrl).toBe('https://app.odonto.com.br');
    expect(config.corsOrigins).toEqual(['https://a.com', 'https://b.com']);
    expect(config.smtpFrom).toBe('envio@odonto.com.br');
    expect(config.databaseSsl).toBe(true);

    vi.stubEnv('SMTP_FROM', undefined);
    expect(config.smtpFrom).toBe('contato@odonto.com.br');
  });

  it('número inválido, zero ou negativo cai no padrão', () => {
    for (const bad of ['abc', '0', '-5', '']) {
      vi.stubEnv('PORT', bad);
      expect(config.port).toBe(3000);
    }
  });

  it('segredos e URL do banco são obrigatórios', () => {
    expect(config.jwtSecret).toBe('segredo-de-teste');
    expect(config.platformJwtSecret).toBe('segredo-da-plataforma-de-teste');
    expect(config.databaseUrl).toMatch(/^postgres/);
    for (const name of ['JWT_SECRET', 'JWT_SECRET_PLATFORM', 'DATABASE_URL']) vi.stubEnv(name, '');
    expect(() => config.jwtSecret).toThrow('JWT_SECRET');
    expect(() => config.platformJwtSecret).toThrow('JWT_SECRET_PLATFORM');
    expect(() => config.databaseUrl).toThrow('DATABASE_URL');
  });

  it('buildKnexConfig monta a conexão (SSL opcional) e aponta para a pasta de migrations', () => {
    const plain = buildKnexConfig();
    expect(plain).toMatchObject({ client: 'pg', pool: { min: 0, max: 10 } });
    expect(plain.connection).toMatchObject({ connectionString: process.env.DATABASE_URL, ssl: false });
    expect(plain.migrations.directory).toMatch(/migrations$/);

    vi.stubEnv('DATABASE_SSL', 'true');
    vi.stubEnv('DB_POOL_MAX', '3');
    const ssl = buildKnexConfig();
    expect(ssl.connection.ssl).toEqual({ rejectUnauthorized: false });
    expect(ssl.pool.max).toBe(3);
  });
});

describe('utils/errors', () => {
  it('helpers montam HttpError com o status certo', () => {
    expect(badRequest('x', { a: 1 })).toMatchObject({ status: 400, message: 'x', extra: { a: 1 } });
    expect(unauthorized()).toMatchObject({ status: 401, message: 'Não autorizado.' });
    expect(unauthorized('nope')).toMatchObject({ status: 401, message: 'nope' });
    expect(forbidden()).toMatchObject({ status: 403, message: 'Sem permissão para esta ação.' });
    expect(forbidden('não', { code: 'X' })).toMatchObject({ status: 403, extra: { code: 'X' } });
    expect(notFound()).toMatchObject({ status: 404, message: 'Recurso não encontrado(a).' });
    expect(notFound('Paciente').message).toBe('Paciente não encontrado(a).');
    expect(conflict('dup')).toMatchObject({ status: 409 });
    expect(emailNotVerified()).toMatchObject({ status: 403, extra: { code: 'EMAIL_NOT_VERIFIED' } });
    expect(tooManyRequests('calma', 30)).toMatchObject({ status: 429, extra: { code: 'RATE_LIMITED', retryAfterSeconds: 30 } });
    expect(new HttpError(418, 'bule')).toMatchObject({ name: 'HttpError', extra: {} });
    expect(new HttpError(418, 'bule')).toBeInstanceOf(Error);
  });
});

describe('utils/slug', () => {
  it.each([
    ['Clínica Sorriso & Cia', 'clinica-sorriso-cia'],
    ['  Ação — Odontologia!!  ', 'acao-odontologia'],
    ['!!!', 'clinica'],
    ['', 'clinica'],
    ['a'.repeat(59) + '-bbbb', 'a'.repeat(59)],
    ['a'.repeat(100), 'a'.repeat(60)],
  ])('slugify(%j) = %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});

describe('utils/pagination', () => {
  it('calcula limite, deslocamento e o resultado paginado', () => {
    expect(paginate({ page: 1, perPage: 20 })).toEqual({ limit: 20, offset: 0 });
    expect(paginate({ page: 3, perPage: 10 })).toEqual({ limit: 10, offset: 20 });
    expect(pageResult(['a'], 21, { page: 2, perPage: 10 })).toEqual({ data: ['a'], page: 2, perPage: 10, total: 21, totalPages: 3 });
    expect(pageResult([], 0, { page: 1, perPage: 10 }).totalPages).toBe(0);
  });

  it('escapeLike trata % _ e \\ como texto', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b');
    expect(escapeLike('normal')).toBe('normal');
  });
});

describe('utils/dto', () => {
  const user = { id: 'u', clinic_id: 'c', name: 'Ana', email: 'a@a.com', role: 'admin', active: true, email_verified_at: new Date(), password_hash: 'segredo', created_at: 1, updated_at: 2 };
  it('nunca expõe o hash da senha e resume a verificação de e-mail', () => {
    expect(toUserDto(user)).toEqual({ id: 'u', clinicId: 'c', name: 'Ana', email: 'a@a.com', role: 'admin', active: true, emailVerified: true, createdAt: 1, updatedAt: 2 });
    expect(toUserDto({ ...user, email_verified_at: null }).emailVerified).toBe(false);
    expect(toClinicDto({ id: 'c', name: 'N', slug: 's', document: null, plan: 'basic', status: 'active', created_at: 1, updated_at: 2 }))
      .toEqual({ id: 'c', name: 'N', slug: 's', document: null, plan: 'basic', status: 'active', createdAt: 1, updatedAt: 2 });
    expect(toPlatformAdminDto({ id: 'p', name: 'P', email: 'p@p.com', active: true, password_hash: 'x' })).toEqual({ id: 'p', name: 'P', email: 'p@p.com', active: true });
  });
});

describe('utils/session', () => {
  it('sessão emitida antes da troca de senha é inválida', () => {
    const changed = new Date('2026-01-01T00:00:10Z');
    const sec = Math.floor(changed.getTime() / 1000);
    expect(issuedBeforePasswordChange(null, sec)).toBe(false);
    expect(issuedBeforePasswordChange(changed, sec - 1)).toBe(true);
    expect(issuedBeforePasswordChange(changed, sec)).toBe(false);
    expect(issuedBeforePasswordChange(changed, sec + 1)).toBe(false);
  });
});

describe('utils/loginThrottle', () => {
  it('trava ao atingir o máximo de falhas na janela e libera depois', () => {
    const t = createLoginThrottle({ maxFailures: 3, windowMs: 1000 });
    expect(t.blockedFor('k')).toBe(0);
    t.fail('k', 0);
    t.fail('k', 10);
    expect(t.blockedFor('k', 20)).toBe(0); // ainda não travou
    t.fail('k', 20);
    expect(t.blockedFor('k', 500)).toBe(1);
    expect(t.blockedFor('k', 1020)).toBe(0); // travamento expirou
  });

  it('a janela de contagem recomeça depois de expirar; reset e clear limpam', () => {
    const t = createLoginThrottle({ maxFailures: 2, windowMs: 1000 });
    t.fail('k', 0);
    t.fail('k', 2000); // janela anterior expirou: conta de novo
    expect(t.blockedFor('k', 2001)).toBe(0);
    t.fail('k', 2002);
    expect(t.blockedFor('k', 2003)).toBe(1);
    t.reset('k');
    expect(t.blockedFor('k', 2003)).toBe(0);

    t.fail('a', 0); t.fail('a', 1);
    t.clear();
    expect(t.blockedFor('a', 2)).toBe(0);
  });

  it('usa o relógio real quando o instante não é informado', () => {
    const t = createLoginThrottle({ maxFailures: 1, windowMs: 60000 });
    t.fail('k');
    expect(t.blockedFor('k')).toBeGreaterThan(0);
  });
});

describe('services/password e tokens', () => {
  it('hash de senha confere só com a senha certa', async () => {
    const hash = await hashPassword('minha-senha-1');
    expect(hash).not.toContain('minha-senha-1');
    expect(await verifyPassword('minha-senha-1', hash)).toBe(true);
    expect(await verifyPassword('outra-senha', hash)).toBe(false);
  });

  it('JWT de acesso leva usuário, clínica e perfil', () => {
    const token = signAccessToken({ id: 'u-1', clinic_id: 'c-1', role: 'dentist' });
    expect(verifyAccessToken(token)).toMatchObject({ sub: 'u-1', cid: 'c-1', role: 'dentist' });
    expect(() => verifyAccessToken(`${token}x`)).toThrow();
  });

  it('tokens opacos são aleatórios e o hash é estável', () => {
    const a = generateOpaqueToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateOpaqueToken()).not.toBe(a);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
