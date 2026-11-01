import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { hashToken } from '../src/services/tokens.js';
import { api, bearer, createClinic, createUser, PASSWORD, setupUser } from './helpers/factories.js';

const login = (body) => api().post('/api/auth/login').send(body);

describe('POST /api/auth/login', () => {
  it('entra com e-mail e senha e devolve tokens, usuário e clínica (sem expor a senha)', async () => {
    const clinic = await createClinic({ name: 'Sorriso' });
    const user = await createUser(clinic, { role: 'dentist' });
    const res = await login({ email: user.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user).toMatchObject({ id: user.id, clinicId: clinic.id, role: 'dentist', email: user.email, emailVerified: true });
    expect(res.body.clinic).toMatchObject({ id: clinic.id, name: 'Sorriso', status: 'active' });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  it('guarda só o hash do refresh token', async () => {
    const { session, user } = await setupUser();
    const rows = await db('refresh_tokens').where({ user_id: user.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashToken(session.refreshToken));
    expect(rows[0].token_hash).not.toBe(session.refreshToken);
    expect(rows[0].expires_at.getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
  });

  it('ignora maiúsculas e espaços no e-mail', async () => {
    const user = await createUser(await createClinic());
    const res = await login({ email: `  ${user.email.toUpperCase()} `, password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('senha errada e e-mail desconhecido respondem igual (401)', async () => {
    const user = await createUser(await createClinic());
    const wrong = await login({ email: user.email, password: 'errada-errada' });
    const unknown = await login({ email: 'ninguem@teste.com', password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('usuário desativado: 403 USER_INACTIVE (só depois de acertar a senha)', async () => {
    const user = await createUser(await createClinic(), { active: false });
    const ok = await login({ email: user.email, password: PASSWORD });
    expect(ok.status).toBe(403);
    expect(ok.body.code).toBe('USER_INACTIVE');
    expect((await login({ email: user.email, password: 'errada-errada' })).status).toBe(401);
  });

  it('clínica suspensa: 403 CLINIC_SUSPENDED', async () => {
    const user = await createUser(await createClinic({ status: 'suspended' }));
    const res = await login({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CLINIC_SUSPENDED');
  });

  it('e-mail não verificado: 403 EMAIL_NOT_VERIFIED (só depois de acertar a senha) e nenhuma sessão é criada', async () => {
    const user = await createUser(await createClinic(), { email_verified_at: null });
    const res = await login({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(await db('refresh_tokens').where({ user_id: user.id })).toHaveLength(0);
    expect((await login({ email: user.email, password: 'errada-errada' })).status).toBe(401);
  });

  it('valida o corpo (400 com detalhes)', async () => {
    const res = await login({ email: 'nao-e-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Dados inválidos');
    expect(res.body.details.map((d) => d.field).sort()).toEqual(['email', 'password']);
  });

  it('trava depois de 5 erros seguidos do mesmo e-mail (429 + Retry-After) e acertar zera a contagem', async () => {
    const user = await createUser(await createClinic());
    for (let i = 0; i < 4; i += 1) expect((await login({ email: user.email, password: 'errada-errada' })).status).toBe(401);
    expect((await login({ email: user.email, password: PASSWORD })).status).toBe(200); // zera
    for (let i = 0; i < 5; i += 1) expect((await login({ email: user.email, password: 'errada-errada' })).status).toBe(401);

    const blocked = await login({ email: user.email, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // outro e-mail, mesmo IP: não é afetado pelo travamento deste
    const other = await createUser(await createClinic());
    expect((await login({ email: other.email, password: PASSWORD })).status).toBe(200);
  });
});

describe('GET /api/auth/me e proteção das rotas', () => {
  it('devolve o perfil de quem está logado', async () => {
    const { headers, user, clinic } = await setupUser({ role: 'secretary' });
    const res = await api().get('/api/auth/me').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, role: 'secretary' });
    expect(res.body.clinic.id).toBe(clinic.id);
  });

  it.each([
    ['sem cabeçalho', {}],
    ['esquema errado', { Authorization: 'Basic abc' }],
    ['sem token', { Authorization: 'Bearer' }],
    ['token inválido', { Authorization: 'Bearer lixo.lixo.lixo' }],
  ])('401 %s', async (_nome, headers) => {
    expect((await api().get('/api/auth/me').set(headers)).status).toBe(401);
  });

  it('token assinado com o segredo da plataforma não vale para clínica', async () => {
    const { signPlatformToken } = await import('../src/services/tokens.js');
    const token = signPlatformToken({ id: '00000000-0000-0000-0000-000000000000' });
    expect((await api().get('/api/auth/me').set(bearer(token))).status).toBe(401);
  });

  it('401 se o usuário foi desativado ou apagado depois do login', async () => {
    const a = await setupUser();
    await db('users').where({ id: a.user.id }).update({ active: false });
    expect((await api().get('/api/auth/me').set(a.headers)).status).toBe(401);

    const b = await setupUser();
    await db('users').where({ id: b.user.id }).del();
    expect((await api().get('/api/auth/me').set(b.headers)).status).toBe(401);
  });

  it('401 se a senha foi trocada depois da emissão do token', async () => {
    const { headers, user } = await setupUser();
    await db('users').where({ id: user.id }).update({ password_changed_at: new Date(Date.now() + 5000) });
    expect((await api().get('/api/auth/me').set(headers)).status).toBe(401);
  });

  it('403 EMAIL_NOT_VERIFIED se o e-mail deixou de estar verificado depois do login', async () => {
    const { headers, user } = await setupUser();
    await db('users').where({ id: user.id }).update({ email_verified_at: null });
    const res = await api().get('/api/auth/me').set(headers);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('403 se a clínica foi suspensa depois do login', async () => {
    const { headers, clinic } = await setupUser();
    await db('clinics').where({ id: clinic.id }).update({ status: 'suspended' });
    const res = await api().get('/api/auth/me').set(headers);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CLINIC_SUSPENDED');
  });
});
