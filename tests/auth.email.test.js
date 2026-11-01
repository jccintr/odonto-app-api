import { describe, expect, it, vi } from 'vitest';
import db from '../src/db/knex.js';
import { sendVerificationEmail } from '../src/services/mailer.js';
import { sendVerification } from '../src/modules/auth/auth.service.js';
import { hashToken } from '../src/services/tokens.js';
import { api, createClinic, createUser, PASSWORD } from './helpers/factories.js';
import { lastVerificationToken } from './helpers/mail.js';

const verify = (token) => api().post('/api/auth/verify-email').send({ token });
const resend = (email) => api().post('/api/auth/resend-verification').send({ email });
const login = (user) => api().post('/api/auth/login').send({ email: user.email, password: PASSWORD });

describe('verificação de e-mail', () => {
  it('o link enviado confirma o e-mail do usuário', async () => {
    const user = await createUser(await createClinic(), { name: 'Ana' });
    await sendVerification(user);

    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    const mail = sendVerificationEmail.mock.calls[0][0];
    expect(mail).toMatchObject({ to: user.email, name: 'Ana', hours: 24 });
    expect(mail.url).toMatch(/^http:\/\/localhost:5173\/verificar-email\?token=/);

    const res = await verify(lastVerificationToken());
    expect(res.status).toBe(200);
    expect((await db('users').where({ id: user.id }).first()).email_verified_at).not.toBeNull();
  });

  it('guarda só o hash do token e ele só vale uma vez', async () => {
    const user = await createUser(await createClinic());
    await sendVerification(user);
    const token = lastVerificationToken();

    const row = await db('auth_tokens').where({ user_id: user.id }).first();
    expect(row.token_hash).toBe(hashToken(token));
    expect(row.type).toBe('email_verification');

    expect((await verify(token)).status).toBe(200);
    expect((await verify(token)).status).toBe(400);
  });

  it('um token novo invalida o anterior', async () => {
    const user = await createUser(await createClinic());
    await sendVerification(user);
    const first = lastVerificationToken();
    await sendVerification(user);
    expect((await verify(first)).status).toBe(400);
    expect((await verify(lastVerificationToken())).status).toBe(200);
  });

  it('token expirado, desconhecido ou de outro tipo: 400', async () => {
    const user = await createUser(await createClinic());
    await sendVerification(user);
    const token = lastVerificationToken();
    await db('auth_tokens').where({ user_id: user.id }).update({ expires_at: new Date(Date.now() - 1000) });

    expect((await verify(token)).status).toBe(400);
    expect((await verify('nao-existe')).status).toBe(400);

    await db('auth_tokens').where({ user_id: user.id }).update({ expires_at: new Date(Date.now() + 60000), type: 'password_reset' });
    expect((await verify(token)).status).toBe(400);
  });

  it('não altera a data se o e-mail já estava verificado', async () => {
    const verifiedAt = new Date('2026-01-01T00:00:00Z');
    const user = await createUser(await createClinic(), { email_verified_at: verifiedAt });
    await sendVerification(user);
    expect((await verify(lastVerificationToken())).status).toBe(200);
    expect((await db('users').where({ id: user.id }).first()).email_verified_at).toEqual(verifiedAt);
  });

  it('primeiro acesso: só entra depois de confirmar o e-mail', async () => {
    const user = await createUser(await createClinic(), { email_verified_at: null });
    expect((await login(user)).body.code).toBe('EMAIL_NOT_VERIFIED');

    await sendVerification(user);
    expect((await verify(lastVerificationToken())).status).toBe(200);
    const ok = await login(user);
    expect(ok.status).toBe(200);
    expect(ok.body.user.emailVerified).toBe(true);
  });

  it('valida o corpo (400)', async () => {
    expect((await api().post('/api/auth/verify-email').send({})).status).toBe(400);
  });
});

describe('POST /api/auth/resend-verification', () => {
  it('reenvia o link para quem ainda não verificou o e-mail (sem precisar de login)', async () => {
    const user = await createUser(await createClinic(), { email_verified_at: null });
    const res = await resend(user.email);
    expect(res.status).toBe(200);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(sendVerificationEmail.mock.calls[0][0].to).toBe(user.email);
    expect((await verify(lastVerificationToken())).status).toBe(200);
  });

  it('responde igual e não envia nada para e-mail desconhecido, já verificado, usuário desativado ou clínica suspensa', async () => {
    const pending = await createUser(await createClinic(), { email_verified_at: null });
    const known = await resend(pending.email);
    sendVerificationEmail.mockClear();

    const emails = [
      'ninguem@teste.com',
      (await createUser(await createClinic())).email,
      (await createUser(await createClinic(), { email_verified_at: null, active: false })).email,
      (await createUser(await createClinic({ status: 'suspended' }), { email_verified_at: null })).email,
    ];
    for (const email of emails) {
      const res = await resend(email);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(known.body);
    }
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('segundo pedido dentro do intervalo responde igual, mas não envia outro e-mail; libera depois do intervalo', async () => {
    const user = await createUser(await createClinic(), { email_verified_at: null });
    await resend(user.email);
    expect((await resend(user.email)).status).toBe(200);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);

    await db('auth_tokens').where({ user_id: user.id }).update({ created_at: new Date(Date.now() - 120000) });
    await resend(user.email);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(2);
  });

  it('falha no envio só vai para o log: a resposta continua igual', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendVerificationEmail.mockRejectedValueOnce(new Error('smtp fora do ar'));
    const user = await createUser(await createClinic(), { email_verified_at: null });
    expect((await resend(user.email)).status).toBe(200);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('valida o e-mail (400)', async () => {
    expect((await resend('nao-e-email')).status).toBe(400);
    expect((await api().post('/api/auth/resend-verification').send({})).status).toBe(400);
  });
});
