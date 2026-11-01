import { describe, expect, it, vi } from 'vitest';
import db from '../src/db/knex.js';
import { sendPasswordResetEmail } from '../src/services/mailer.js';
import { api, bearer, createClinic, createUser, PASSWORD, setupUser } from './helpers/factories.js';
import { lastResetToken } from './helpers/mail.js';

const forgot = (email) => api().post('/api/auth/forgot-password').send({ email });
const reset = (token, newPassword = 'nova-senha-456') => api().post('/api/auth/reset-password').send({ token, newPassword });
const loginWith = (email, password) => api().post('/api/auth/login').send({ email, password });

describe('POST /api/auth/forgot-password', () => {
  it('envia o link de redefinição ao e-mail do usuário', async () => {
    const user = await createUser(await createClinic(), { name: 'Ana' });
    const res = await forgot(user.email);
    expect(res.status).toBe(200);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const mail = sendPasswordResetEmail.mock.calls[0][0];
    expect(mail).toMatchObject({ to: user.email, name: 'Ana', minutes: 60 });
    expect(mail.url).toMatch(/^http:\/\/localhost:5173\/redefinir-senha\?token=/);
  });

  it('responde igual para e-mail desconhecido e não envia nada', async () => {
    const user = await createUser(await createClinic());
    const known = await forgot(user.email);
    sendPasswordResetEmail.mockClear();
    const unknown = await forgot('ninguem@teste.com');
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('não envia para usuário desativado nem para clínica suspensa', async () => {
    const inactive = await createUser(await createClinic(), { active: false });
    const suspended = await createUser(await createClinic({ status: 'suspended' }));
    expect((await forgot(inactive.email)).status).toBe(200);
    expect((await forgot(suspended.email)).status).toBe(200);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('segundo pedido dentro do intervalo responde igual, mas não envia outro e-mail', async () => {
    const user = await createUser(await createClinic());
    await forgot(user.email);
    const again = await forgot(user.email);
    expect(again.status).toBe(200);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  it('falha no envio só vai para o log: a resposta continua igual', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendPasswordResetEmail.mockRejectedValueOnce(new Error('smtp fora do ar'));
    const user = await createUser(await createClinic());
    expect((await forgot(user.email)).status).toBe(200);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('valida o e-mail (400)', async () => {
    expect((await forgot('nao-e-email')).status).toBe(400);
    expect((await api().post('/api/auth/forgot-password').send({})).status).toBe(400);
  });
});

describe('POST /api/auth/reset-password', () => {
  it('troca a senha: a nova funciona, a antiga não, e as sessões abertas caem', async () => {
    const { user, session } = await setupUser();
    await forgot(user.email);
    expect((await reset(lastResetToken())).status).toBe(200);

    expect((await loginWith(user.email, 'nova-senha-456')).status).toBe(200);
    expect((await loginWith(user.email, PASSWORD)).status).toBe(401);
    expect((await api().post('/api/auth/refresh').send({ refreshToken: session.refreshToken })).status).toBe(401);
  });

  it('o link vale uma vez só e um pedido novo invalida o anterior', async () => {
    const user = await createUser(await createClinic());
    await forgot(user.email);
    const first = lastResetToken();
    expect((await reset(first)).status).toBe(200);
    expect((await reset(first)).status).toBe(400);

    await db('auth_tokens').where({ user_id: user.id }).update({ created_at: new Date(Date.now() - 120000) });
    await forgot(user.email);
    const second = lastResetToken();
    await db('auth_tokens').where({ user_id: user.id }).update({ created_at: new Date(Date.now() - 120000) });
    await forgot(user.email);
    expect((await reset(second)).status).toBe(400);
    expect((await reset(lastResetToken())).status).toBe(200);
  });

  it('quem recebeu o e-mail comprova o endereço: marca como verificado sem mudar uma data já existente', async () => {
    const unverified = await createUser(await createClinic());
    await forgot(unverified.email);
    await reset(lastResetToken());
    expect((await db('users').where({ id: unverified.id }).first()).email_verified_at).not.toBeNull();

    const verifiedAt = new Date('2026-01-01T00:00:00Z');
    const verified = await createUser(await createClinic(), { email_verified_at: verifiedAt });
    await forgot(verified.email);
    await reset(lastResetToken());
    expect((await db('users').where({ id: verified.id }).first()).email_verified_at).toEqual(verifiedAt);
  });

  it('quem ainda não confirmou o e-mail consegue entrar depois de redefinir a senha (o link prova o endereço)', async () => {
    const user = await createUser(await createClinic(), { email_verified_at: null });
    expect((await loginWith(user.email, PASSWORD)).status).toBe(403);
    await forgot(user.email);
    expect((await reset(lastResetToken())).status).toBe(200);
    expect((await loginWith(user.email, 'nova-senha-456')).status).toBe(200);
  });

  it('token expirado ou desconhecido: 400', async () => {
    const user = await createUser(await createClinic());
    await forgot(user.email);
    const token = lastResetToken();
    await db('auth_tokens').where({ user_id: user.id }).update({ expires_at: new Date(Date.now() - 1000) });
    expect((await reset(token)).status).toBe(400);
    expect((await reset('nao-existe')).status).toBe(400);
  });

  it('valida a senha nova (400)', async () => {
    expect((await reset('qualquer', 'curta')).status).toBe(400);
    expect((await reset('qualquer', 'x'.repeat(73))).status).toBe(400);
    expect((await api().post('/api/auth/reset-password').send({})).status).toBe(400);
  });
});

describe('POST /api/auth/change-password', () => {
  const change = (headers, body) => api().post('/api/auth/change-password').set(headers).send(body);

  it('troca a senha, encerra as outras sessões e devolve uma sessão nova', async () => {
    const { headers, user, session } = await setupUser();
    const res = await change(headers, { currentPassword: PASSWORD, newPassword: 'nova-senha-456' });
    expect(res.status).toBe(200);
    expect((await api().get('/api/auth/me').set(bearer(res.body.accessToken))).status).toBe(200);

    expect((await loginWith(user.email, 'nova-senha-456')).status).toBe(200);
    expect((await loginWith(user.email, PASSWORD)).status).toBe(401);
    expect((await api().post('/api/auth/refresh').send({ refreshToken: session.refreshToken })).status).toBe(401);
  });

  it('senha atual incorreta: 400 WRONG_PASSWORD (não é 401, para o app não deslogar)', async () => {
    const { headers } = await setupUser();
    const res = await change(headers, { currentPassword: 'errada-errada', newPassword: 'nova-senha-456' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WRONG_PASSWORD');
  });

  it('valida o corpo (400) e exige login (401)', async () => {
    const { headers } = await setupUser();
    expect((await change(headers, { currentPassword: PASSWORD, newPassword: 'curta' })).status).toBe(400);
    expect((await api().post('/api/auth/change-password').send({})).status).toBe(401);
  });
});
