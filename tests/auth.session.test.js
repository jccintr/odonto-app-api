import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { hashToken } from '../src/services/tokens.js';
import { api, bearer, setupUser } from './helpers/factories.js';

const refresh = (refreshToken) => api().post('/api/auth/refresh').send({ refreshToken });
const logout = (refreshToken) => api().post('/api/auth/logout').send({ refreshToken });

describe('POST /api/auth/refresh', () => {
  it('troca o refresh token por uma sessão nova e invalida o antigo (rotação)', async () => {
    const { session } = await setupUser();
    const res = await refresh(session.refreshToken);
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(session.refreshToken);
    expect((await api().get('/api/auth/me').set(bearer(res.body.accessToken))).status).toBe(200);

    const old = await db('refresh_tokens').where({ token_hash: hashToken(session.refreshToken) }).first();
    expect(old.revoked_at).not.toBeNull();
  });

  it('reuso de um token já gasto encerra todas as sessões do usuário', async () => {
    const { session } = await setupUser();
    const fresh = (await refresh(session.refreshToken)).body;

    const reused = await refresh(session.refreshToken);
    expect(reused.status).toBe(401);
    expect((await refresh(fresh.refreshToken)).status).toBe(401); // o token novo também caiu
  });

  it('token desconhecido: 401', async () => {
    expect((await refresh('nao-existe')).status).toBe(401);
  });

  it('token expirado: 401, sem derrubar as outras sessões', async () => {
    const { session, user } = await setupUser();
    const other = (await api().post('/api/auth/login').send({ email: user.email, password: 'senha-segura-123' })).body;
    await db('refresh_tokens').where({ token_hash: hashToken(session.refreshToken) }).update({ expires_at: new Date(Date.now() - 1000) });

    expect((await refresh(session.refreshToken)).status).toBe(401);
    expect((await refresh(other.refreshToken)).status).toBe(200);
  });

  it('usuário desativado ou clínica suspensa: 403', async () => {
    const a = await setupUser();
    await db('users').where({ id: a.user.id }).update({ active: false });
    const inactive = await refresh(a.session.refreshToken);
    expect(inactive.status).toBe(403);
    expect(inactive.body.code).toBe('USER_INACTIVE');

    const b = await setupUser();
    await db('clinics').where({ id: b.clinic.id }).update({ status: 'suspended' });
    const suspended = await refresh(b.session.refreshToken);
    expect(suspended.status).toBe(403);
    expect(suspended.body.code).toBe('CLINIC_SUSPENDED');
  });

  it('e-mail que deixou de estar verificado: 403 EMAIL_NOT_VERIFIED', async () => {
    const { session, user } = await setupUser();
    await db('users').where({ id: user.id }).update({ email_verified_at: null });
    const res = await refresh(session.refreshToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('valida o corpo (400)', async () => {
    expect((await api().post('/api/auth/refresh').send({})).status).toBe(400);
  });
});

describe('POST /api/auth/logout', () => {
  it('revoga o refresh token (204)', async () => {
    const { session } = await setupUser();
    expect((await logout(session.refreshToken)).status).toBe(204);
    expect((await refresh(session.refreshToken)).status).toBe(401);
  });

  it('é idempotente e não revela se o token existe (204)', async () => {
    const { session } = await setupUser();
    await logout(session.refreshToken);
    expect((await logout(session.refreshToken)).status).toBe(204);
    expect((await logout('nao-existe')).status).toBe(204);
  });

  it('valida o corpo (400)', async () => {
    expect((await api().post('/api/auth/logout').send({})).status).toBe(400);
  });
});
