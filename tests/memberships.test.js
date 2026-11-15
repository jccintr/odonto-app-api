// A pessoa (login) é uma só no sistema; o vínculo com cada clínica tem perfil e situação próprios.
// Cobre: dentista em várias clínicas, troca de clínica, convite para quem já tem conta, administrador que também atende.
import { describe, expect, it, vi } from 'vitest';
import db from '../src/db/knex.js';
import { sendInviteEmail, sendPasswordResetEmail, sendVerificationEmail } from '../src/services/mailer.js';
import {
  PASSWORD, addMembership, api, bearer, createClinic, createDentist, createPatient, createProcedure, createUser, enableAttends, loginAs,
  platformSession, setupUser, updateMembership,
} from './helpers/factories.js';
import { lastInviteToken } from './helpers/mail.js';

const login = (body) => api().post('/api/auth/login').send(body);
const T = (h) => `2099-11-03T${String(h).padStart(2, '0')}:00:00.000Z`;
const planId = async (code) => (await db('plans').where({ code }).first('id')).id;
const onPlan = async (clinicId, code) => db('subscriptions').where({ clinic_id: clinicId }).update({ plan_id: await planId(code) });

/** Uma pessoa com vínculo aceito em duas clínicas (perfis diferentes em cada uma). */
async function twoClinics() {
  const a = await createClinic({ name: 'Alfa Odonto' });
  const b = await createClinic({ name: 'Beta Sorrisos' });
  const person = await createUser(b, { role: 'dentist', name: 'Dr. Duplo' });
  await addMembership(person, a, { role: 'admin' });
  return { a, b, person };
}

describe('login de quem trabalha em mais de uma clínica', () => {
  it('sem clinicId: devolve as clínicas para escolher (em ordem de nome, com o perfil em cada uma)', async () => {
    const { a, b, person } = await twoClinics();
    const res = await login({ email: person.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      clinicSelectionRequired: true,
      clinics: [
        { id: a.id, name: 'Alfa Odonto', slug: a.slug, role: 'admin' },
        { id: b.id, name: 'Beta Sorrisos', slug: b.slug, role: 'dentist' },
      ],
    });
    expect(await db('refresh_tokens')).toHaveLength(0); // escolher a clínica ainda não abre sessão
  });

  it('com clinicId: entra na clínica escolhida, com o perfil de lá', async () => {
    const { a, b, person } = await twoClinics();
    const inA = await login({ email: person.email, password: PASSWORD, clinicId: a.id });
    expect(inA.status).toBe(200);
    expect(inA.body.user).toMatchObject({ id: person.id, clinicId: a.id, role: 'admin', attendsPatients: false });
    expect(inA.body.clinic.id).toBe(a.id);
    const inB = await login({ email: person.email, password: PASSWORD, clinicId: b.id });
    expect(inB.body.user).toMatchObject({ id: person.id, clinicId: b.id, role: 'dentist', attendsPatients: true });
    expect((await api().get('/api/auth/me').set(bearer(inB.body.accessToken))).body.user.role).toBe('dentist');
  });

  it('clinicId de uma clínica sem vínculo, ou com convite ainda pendente: 403 NO_CLINIC_ACCESS', async () => {
    const { person } = await twoClinics();
    const stranger = await createClinic();
    const pending = await createClinic();
    await addMembership(person, pending, { role: 'secretary', accepted_at: null });
    for (const clinicId of [stranger.id, pending.id]) {
      const res = await login({ email: person.email, password: PASSWORD, clinicId });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NO_CLINIC_ACCESS');
    }
  });

  it('vínculo desativado ou clínica suspensa ficam fora da lista; sobrando uma, entra direto nela', async () => {
    const { a, b, person } = await twoClinics();
    const c = await createClinic({ name: 'Gama' });
    await addMembership(person, c, { role: 'dentist' });
    await updateMembership(person, { active: false }, a.id);
    await db('clinics').where({ id: c.id }).update({ status: 'suspended' });
    const res = await login({ email: person.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.clinic.id).toBe(b.id);
  });

  it('nenhuma clínica utilizável: o primeiro vínculo diz o motivo', async () => {
    const { a, b, person } = await twoClinics();
    await updateMembership(person, { active: false }, a.id);
    await db('clinics').where({ id: b.id }).update({ status: 'suspended' });
    const res = await login({ email: person.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('USER_INACTIVE'); // Alfa vem primeiro (ordem de nome)
  });

  it('só convites pendentes (ou nenhum vínculo): 403 NO_CLINIC_ACCESS pedindo para aceitar o convite', async () => {
    const invitedOnly = await createUser(await createClinic(), { accepted_at: null });
    const res = await login({ email: invitedOnly.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'NO_CLINIC_ACCESS' });
    expect(res.body.error).toContain('convite');

    const [orphan] = await db('users').insert({ name: 'Sem Clínica', email: 'orfao@x.com', password_hash: invitedOnly.password_hash, email_verified_at: new Date() }).returning('*');
    expect((await login({ email: orphan.email, password: PASSWORD })).body.code).toBe('NO_CLINIC_ACCESS');
  });

  it('a lista de clínicas também exige o e-mail confirmado', async () => {
    const { person } = await twoClinics();
    await db('users').where({ id: person.id }).update({ email_verified_at: null });
    const res = await login({ email: person.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('senha errada continua 401, sem revelar as clínicas', async () => {
    const { person } = await twoClinics();
    const res = await login({ email: person.email, password: 'senha-errada-123' });
    expect(res.status).toBe(401);
    expect(res.body.clinics).toBeUndefined();
  });
});

describe('minhas clínicas e troca de clínica', () => {
  it('GET /api/auth/clinics lista só as clínicas em que dá para entrar agora', async () => {
    const { a, b, person } = await twoClinics();
    const pending = await createClinic({ name: 'Convite Pendente' });
    await addMembership(person, pending, { accepted_at: null });
    const session = await loginAs(person, PASSWORD, a.id);
    const res = await api().get('/api/auth/clinics').set(bearer(session.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.map((c) => c.id)).toEqual([a.id, b.id]);
  });

  it('POST /api/auth/switch-clinic devolve uma sessão na outra clínica, sem pedir senha', async () => {
    const { a, b, person } = await twoClinics();
    const session = await loginAs(person, PASSWORD, a.id);
    const res = await api().post('/api/auth/switch-clinic').set(bearer(session.accessToken)).send({ clinicId: b.id });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ clinicId: b.id, role: 'dentist' });
    const me = await api().get('/api/auth/me').set(bearer(res.body.accessToken));
    expect(me.body.clinic.id).toBe(b.id);
    // a sessão antiga continua valendo, na clínica antiga
    expect((await api().get('/api/auth/me').set(bearer(session.accessToken))).body.clinic.id).toBe(a.id);
  });

  it('troca para clínica sem vínculo, com convite pendente, vínculo desativado ou clínica suspensa: 403', async () => {
    const { a, b, person } = await twoClinics();
    const headers = bearer((await loginAs(person, PASSWORD, a.id)).accessToken);
    const sw = (clinicId) => api().post('/api/auth/switch-clinic').set(headers).send({ clinicId });
    expect((await sw((await createClinic()).id)).body.code).toBe('NO_CLINIC_ACCESS');
    const pending = await createClinic();
    await addMembership(person, pending, { accepted_at: null });
    expect((await sw(pending.id)).body.code).toBe('NO_CLINIC_ACCESS');
    await updateMembership(person, { active: false }, b.id);
    expect((await sw(b.id)).body.code).toBe('USER_INACTIVE');
    await updateMembership(person, { active: true }, b.id);
    await db('clinics').where({ id: b.id }).update({ status: 'suspended' });
    expect((await sw(b.id)).body.code).toBe('CLINIC_SUSPENDED');
  });

  it('o refresh renova na mesma clínica da sessão', async () => {
    const { b, person } = await twoClinics();
    const session = await loginAs(person, PASSWORD, b.id);
    const res = await api().post('/api/auth/refresh').send({ refreshToken: session.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.user.clinicId).toBe(b.id);
  });

  it('refresh de vínculo que voltou a convite pendente ou foi apagado: 401', async () => {
    const { a, b, person } = await twoClinics();
    const inA = await loginAs(person, PASSWORD, a.id);
    const inB = await loginAs(person, PASSWORD, b.id);
    await updateMembership(person, { accepted_at: null }, a.id);
    expect((await api().post('/api/auth/refresh').send({ refreshToken: inA.refreshToken })).status).toBe(401);
    await db('dentists').where({ user_id: person.id }).del();
    await db('memberships').where({ user_id: person.id, clinic_id: b.id }).del();
    expect((await api().post('/api/auth/refresh').send({ refreshToken: inB.refreshToken })).status).toBe(401);
  });

  it('desativar a pessoa numa clínica derruba só as sessões de lá', async () => {
    const { a, b, person } = await twoClinics();
    const adminB = await setupUser({ clinic: b });
    const inA = await loginAs(person, PASSWORD, a.id);
    const inB = await loginAs(person, PASSWORD, b.id);
    expect((await api().patch(`/api/users/${person.id}`).set(adminB.headers).send({ active: false })).status).toBe(200);
    expect((await api().post('/api/auth/refresh').send({ refreshToken: inB.refreshToken })).status).toBe(401);
    expect((await api().post('/api/auth/refresh').send({ refreshToken: inA.refreshToken })).status).toBe(200);
  });

  it('trocar a senha vale para todas as clínicas: as sessões das outras caem e a atual recebe uma nova', async () => {
    const { a, b, person } = await twoClinics();
    const inA = await loginAs(person, PASSWORD, a.id);
    const inB = await loginAs(person, PASSWORD, b.id);
    const res = await api().post('/api/auth/change-password').set(bearer(inB.accessToken)).send({ currentPassword: PASSWORD, newPassword: 'senha-nova-da-pessoa' });
    expect(res.status).toBe(200);
    expect(res.body.user.clinicId).toBe(b.id);
    expect((await api().post('/api/auth/refresh').send({ refreshToken: inA.refreshToken })).status).toBe(401);
    expect((await login({ email: person.email, password: 'senha-nova-da-pessoa', clinicId: a.id })).status).toBe(200);
  });
});

describe('meu perfil e o nome da pessoa', () => {
  it('GET /api/auth/me mostra o perfil nesta clínica e se atende pacientes', async () => {
    const { clinic, user, headers } = await setupUser();
    const dentist = await enableAttends(user, clinic);
    const res = await api().get('/api/auth/me').set(headers);
    expect(res.body.user).toMatchObject({ role: 'admin', attendsPatients: true, dentistId: dentist.id, invitePending: false });
  });

  it('PATCH /api/auth/me altera o nome, que vale em todas as clínicas', async () => {
    const { a, b, person } = await twoClinics();
    const headers = bearer((await loginAs(person, PASSWORD, a.id)).accessToken);
    const res = await api().patch('/api/auth/me').set(headers).send({ name: '  Dr. Duplo Silva ' });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Dr. Duplo Silva');
    const adminB = await setupUser({ clinic: b });
    expect((await api().get(`/api/users/${person.id}`).set(adminB.headers)).body.name).toBe('Dr. Duplo Silva');
    expect((await api().patch('/api/auth/me').set(headers).send({ name: 'x' })).status).toBe(400);
  });

  it('o administrador não altera o nome de quem também está em outra clínica (422 SHARED_ACCOUNT), mas altera perfil e situação', async () => {
    const { b, person } = await twoClinics();
    const adminB = await setupUser({ clinic: b });
    const rename = await api().patch(`/api/users/${person.id}`).set(adminB.headers).send({ name: 'Outro Nome' });
    expect(rename.status).toBe(422);
    expect(rename.body.code).toBe('SHARED_ACCOUNT');
    expect((await db('users').where({ id: person.id }).first()).name).toBe('Dr. Duplo');
    expect((await api().patch(`/api/users/${person.id}`).set(adminB.headers).send({ role: 'secretary' })).body.role).toBe('secretary');
  });
});

describe('convite para quem já tem conta (dentista que trocou de clínica ou atende em duas)', () => {
  async function scenario() {
    const old = await setupUser();
    const { user: dentist } = await createDentist(old.clinic, { name: 'Dra. Bia', email: 'bia@x.com' });
    const next = await setupUser();
    return { old, dentist, next };
  }
  const invite = (s, extra = {}) => api().post('/api/users').set(s.next.headers).send({ name: 'Bia (digitado pela clínica)', email: 'BIA@x.com', role: 'dentist', ...extra });

  it('cadastrar um e-mail que já tem conta convida a pessoa: sem conta nova, sem senha, vínculo pendente', async () => {
    const s = await scenario();
    const res = await invite(s, { password: 'qualquer-senha-ignorada' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: s.dentist.id, name: 'Dra. Bia', clinicId: s.next.clinic.id, role: 'dentist', invitePending: true, attendsPatients: true });
    expect(await db('users').where({ email: 'bia@x.com' })).toHaveLength(1);
    expect(await db('memberships').where({ user_id: s.dentist.id })).toHaveLength(2);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
    expect(sendInviteEmail).toHaveBeenCalledTimes(1);
    expect(sendInviteEmail.mock.calls[0][0]).toMatchObject({ to: 'bia@x.com', name: 'Dra. Bia', clinicName: s.next.clinic.name, role: 'dentist', days: 7 });
    expect(sendInviteEmail.mock.calls[0][0].url).toMatch(/^http:\/\/localhost:5173\/aceitar-convite\?token=/);
    // a senha da pessoa não mudou
    expect((await login({ email: 'bia@x.com', password: PASSWORD })).body.clinic.id).toBe(s.old.clinic.id);
  });

  it('enquanto não aceita, a clínica nova não aparece no login; o link aceita e ela passa a aparecer', async () => {
    const s = await scenario();
    await invite(s);
    const res = await api().post('/api/auth/accept-invite').send({ token: lastInviteToken() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: `Convite aceito! A ${s.next.clinic.name} já aparece para você ao entrar.`,
      clinic: { id: s.next.clinic.id, name: s.next.clinic.name, slug: s.next.clinic.slug, role: 'dentist' },
    });
    const choose = await login({ email: 'bia@x.com', password: PASSWORD });
    expect(choose.body.clinics.map((c) => c.id).sort()).toEqual([s.old.clinic.id, s.next.clinic.id].sort());
    // o link é de uso único
    expect((await api().post('/api/auth/accept-invite').send({ token: lastInviteToken() })).status).toBe(400);
  });

  it('o dentista que saiu da clínica antiga aceita pelo link mesmo sem conseguir entrar em lugar nenhum; o histórico fica na antiga', async () => {
    const s = await scenario();
    await api().patch(`/api/users/${s.dentist.id}`).set(s.old.headers).send({ active: false });
    expect((await login({ email: 'bia@x.com', password: PASSWORD })).body.code).toBe('USER_INACTIVE');
    await invite(s);
    expect((await api().post('/api/auth/accept-invite').send({ token: lastInviteToken() })).status).toBe(200);
    const res = await login({ email: 'bia@x.com', password: PASSWORD });
    expect(res.body.clinic.id).toBe(s.next.clinic.id);
    const profiles = await db('dentists').where({ user_id: s.dentist.id }).orderBy('created_at');
    expect(profiles.map((p) => p.clinic_id)).toEqual([s.old.clinic.id, s.next.clinic.id]);
  });

  it('aceitar pelo link confirma o e-mail de quem ainda não tinha confirmado', async () => {
    const s = await scenario();
    await db('users').where({ id: s.dentist.id }).update({ email_verified_at: null });
    await invite(s);
    await api().post('/api/auth/accept-invite').send({ token: lastInviteToken() });
    expect((await db('users').where({ id: s.dentist.id }).first()).email_verified_at).not.toBeNull();
  });

  it('link inválido: 400; convite cancelado pela clínica (usuário desativado): 400 INVITE_CANCELED', async () => {
    const s = await scenario();
    expect((await api().post('/api/auth/accept-invite').send({ token: 'nao-existe' })).status).toBe(400);
    await invite(s);
    const token = lastInviteToken();
    await api().patch(`/api/users/${s.dentist.id}`).set(s.next.headers).send({ active: false });
    const res = await api().post('/api/auth/accept-invite').send({ token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVITE_CANCELED');
    expect((await db('memberships').where({ user_id: s.dentist.id, clinic_id: s.next.clinic.id }).first()).accepted_at).toBeNull();
  });

  it('convites de clínicas diferentes valem juntos; um convite novo da mesma clínica invalida o anterior', async () => {
    const s = await scenario();
    const third = await setupUser();
    await invite(s);
    const fromNext = lastInviteToken();
    await api().post('/api/users').set(third.headers).send({ name: 'Bia', email: 'bia@x.com', role: 'secretary' });
    const fromThird = lastInviteToken();
    await db('auth_tokens').where({ type: 'membership_invite' }).update({ created_at: new Date(Date.now() - 3_600_000) });
    await api().post(`/api/users/${s.dentist.id}/resend-invite`).set(third.headers);
    expect((await api().post('/api/auth/accept-invite').send({ token: fromThird })).status).toBe(400);
    expect((await api().post('/api/auth/accept-invite').send({ token: fromNext })).status).toBe(200);
    expect((await api().post('/api/auth/accept-invite').send({ token: lastInviteToken() })).body.clinic.role).toBe('secretary');
  });

  it('quem já está logado vê os convites pendentes e aceita pelo app', async () => {
    const s = await scenario();
    await invite(s);
    const suspended = await setupUser();
    await api().post('/api/users').set(suspended.headers).send({ name: 'Bia', email: 'bia@x.com', role: 'secretary' });
    await db('clinics').where({ id: suspended.clinic.id }).update({ status: 'suspended' });
    const canceled = await setupUser();
    await api().post('/api/users').set(canceled.headers).send({ name: 'Bia', email: 'bia@x.com', role: 'secretary' });
    await api().patch(`/api/users/${s.dentist.id}`).set(canceled.headers).send({ active: false });

    const headers = bearer((await loginAs(s.dentist)).accessToken);
    const list = await api().get('/api/auth/invitations').set(headers);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([{ clinic: { id: s.next.clinic.id, name: s.next.clinic.name, slug: s.next.clinic.slug, role: 'dentist' }, invitedAt: expect.any(String) }]);

    const accepted = await api().post(`/api/auth/invitations/${s.next.clinic.id}/accept`).set(headers);
    expect(accepted.status).toBe(200);
    expect(accepted.body.clinic.id).toBe(s.next.clinic.id);
    expect((await api().get('/api/auth/invitations').set(headers)).body).toEqual([]);
    expect((await api().post(`/api/auth/invitations/${s.next.clinic.id}/accept`).set(headers)).status).toBe(404);
    // o link do e-mail deixou de valer: o convite já foi aceito pelo app
    expect((await api().post('/api/auth/accept-invite').send({ token: sendInviteEmail.mock.calls[0][0].url.split('token=')[1] })).status).toBe(400);
  });

  it('reenviar convite: só para quem não aceitou, respeitando o intervalo mínimo', async () => {
    const s = await scenario();
    const created = await invite(s);
    const resend = () => api().post(`/api/users/${created.body.id}/resend-invite`).set(s.next.headers);
    const early = await resend();
    expect(early.status).toBe(429);
    expect(early.body.retryAfterSeconds).toBeGreaterThan(0);
    await db('auth_tokens').where({ type: 'membership_invite' }).update({ created_at: new Date(Date.now() - 3_600_000) });
    const ok = await resend();
    expect(ok.status).toBe(200);
    expect(ok.body.message).toBe('Convite reenviado.');
    expect(sendInviteEmail).toHaveBeenCalledTimes(2);

    await api().patch(`/api/users/${created.body.id}`).set(s.next.headers).send({ active: false });
    expect((await resend()).status).toBe(422);
    await api().patch(`/api/users/${created.body.id}`).set(s.next.headers).send({ active: true });
    await api().post('/api/auth/accept-invite').send({ token: lastInviteToken() });
    const accepted = await resend();
    expect(accepted.status).toBe(409);
    expect(accepted.body.code).toBe('INVITE_ACCEPTED');
    expect((await api().post('/api/users/00000000-0000-4000-8000-000000000000/resend-invite').set(s.next.headers)).status).toBe(404);
  });

  it('falha no envio do convite não derruba o cadastro', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendInviteEmail.mockRejectedValueOnce(new Error('smtp fora do ar'));
    const s = await scenario();
    expect((await invite(s)).status).toBe(201);
    expect(spy).toHaveBeenCalledWith('Falha ao enviar o convite:', expect.any(Error));
    spy.mockRestore();
  });

  it('e-mail novo sem senha inicial: 400 (só quem já tem conta dispensa a senha)', async () => {
    const { headers } = await setupUser();
    const res = await api().post('/api/users').set(headers).send({ name: 'Nova Pessoa', email: 'nova@x.com', role: 'secretary' });
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('password');
    expect(await db('users').where({ email: 'nova@x.com' })).toHaveLength(0);
  });

  it('esqueci a senha e reenviar verificação funcionam para quem só tem convite pendente; não para quem só tem vínculos desativados', async () => {
    const onlyInvite = await createUser(await createClinic(), { accepted_at: null, email_verified_at: null });
    await api().post('/api/auth/forgot-password').send({ email: onlyInvite.email });
    await api().post('/api/auth/resend-verification').send({ email: onlyInvite.email });
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);

    const gone = await createUser(await createClinic(), { active: false, email_verified_at: null });
    await api().post('/api/auth/forgot-password').send({ email: gone.email });
    await api().post('/api/auth/resend-verification').send({ email: gone.email });
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
  });
});

describe('administrador que também atende (clínica pequena)', () => {
  it('cadastrar um administrador que atende cria o perfil clínico; ele aparece em Dentistas com o perfil admin', async () => {
    const { headers } = await setupUser();
    const res = await api().post('/api/users').set(headers).send({ name: 'Dra. Dona', email: 'dona@x.com', password: 'senha-da-dona-1', role: 'admin', attendsPatients: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ role: 'admin', attendsPatients: true, dentistId: expect.any(String) });
    const dentists = (await api().get('/api/dentists').set(headers)).body;
    expect(dentists).toEqual([expect.objectContaining({ id: res.body.dentistId, name: 'Dra. Dona', role: 'admin', active: true })]);
  });

  it('attendsPatients não combina com o perfil: secretária que atende, ou dentista que não atende: 422 INVALID_ATTENDS', async () => {
    const { headers, clinic } = await setupUser();
    const bad = [{ role: 'secretary', attendsPatients: true }, { role: 'dentist', attendsPatients: false }];
    for (const extra of bad) {
      const res = await api().post('/api/users').set(headers).send({ name: 'Alguém', email: 'alguem@x.com', password: 'senha-segura-123', ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(422);
      expect(res.body.code).toBe('INVALID_ATTENDS');
    }
    const secretary = await createUser(clinic, { role: 'secretary' });
    expect((await api().patch(`/api/users/${secretary.id}`).set(headers).send({ attendsPatients: true })).body.code).toBe('INVALID_ATTENDS');
    const { user: dentist } = await createDentist(clinic);
    expect((await api().patch(`/api/users/${dentist.id}`).set(headers).send({ attendsPatients: false })).body.code).toBe('INVALID_ATTENDS');
  });

  it('o próprio administrador liga e desliga o atendimento; o histórico fica e o perfil é reaproveitado', async () => {
    const { headers, user } = await setupUser();
    const on = await api().patch(`/api/users/${user.id}`).set(headers).send({ attendsPatients: true });
    expect(on.status).toBe(200);
    expect(on.body.attendsPatients).toBe(true);
    const dentistId = on.body.dentistId;

    const off = await api().patch(`/api/users/${user.id}`).set(headers).send({ attendsPatients: false });
    expect(off.body).toMatchObject({ attendsPatients: false, dentistId: null });
    expect((await api().get('/api/dentists').set(headers)).body).toEqual([]);
    expect((await api().get(`/api/dentists/${dentistId}`).set(headers)).status).toBe(404);
    expect((await api().patch(`/api/dentists/${dentistId}`).set(headers).send({ cro: 'CRO 1' })).status).toBe(404);
    expect(await db('dentists').where({ id: dentistId }).first()).toMatchObject({ active: false });

    const again = await api().patch(`/api/users/${user.id}`).set(headers).send({ attendsPatients: true });
    expect(again.body.dentistId).toBe(dentistId);
  });

  it('mudanças de perfil: dentista promovido a administrador continua atendendo; quem vira secretária deixa de atender', async () => {
    const { headers, clinic } = await setupUser();
    const { user: dentist, dentist: profile } = await createDentist(clinic);
    const promoted = await api().patch(`/api/users/${dentist.id}`).set(headers).send({ role: 'admin' });
    expect(promoted.body).toMatchObject({ role: 'admin', attendsPatients: true, dentistId: profile.id });
    const demoted = await api().patch(`/api/users/${dentist.id}`).set(headers).send({ role: 'secretary' });
    expect(demoted.body).toMatchObject({ role: 'secretary', attendsPatients: false });
    const back = await api().patch(`/api/users/${dentist.id}`).set(headers).send({ role: 'dentist' });
    expect(back.body.dentistId).toBe(profile.id);
  });

  it('o limite de dentistas do plano conta o administrador que atende', async () => {
    const { headers, clinic, user } = await setupUser();
    await enableAttends(user, clinic);
    await onPlan(clinic.id, 'essencial');
    const blocked = await api().post('/api/users').set(headers).send({ name: 'Dr. Novo', email: 'novo@x.com', password: 'senha-segura-123', role: 'dentist' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('PLAN_LIMIT');

    await api().patch(`/api/users/${user.id}`).set(headers).send({ attendsPatients: false });
    expect((await api().post('/api/users').set(headers).send({ name: 'Dr. Novo', email: 'novo@x.com', password: 'senha-segura-123', role: 'dentist' })).status).toBe(201);
    expect((await api().patch(`/api/users/${user.id}`).set(headers).send({ attendsPatients: true })).body.code).toBe('PLAN_LIMIT');
    // convite também conta e respeita o limite
    const other = await createUser(await createClinic());
    expect((await api().post('/api/users').set(headers).send({ name: 'Xis', email: other.email, role: 'admin', attendsPatients: true })).body.code).toBe('PLAN_LIMIT');
    // trocar para um plano menor conta quem atende
    await onPlan(clinic.id, 'premium');
    await api().patch(`/api/users/${user.id}`).set(headers).send({ attendsPatients: true });
    const downgrade = await api().post('/api/billing/plan').set(headers).send({ planId: await planId('essencial') });
    expect(downgrade.status).toBe(422);
    expect(downgrade.body.code).toBe('PLAN_LIMIT');
  });

  it('convidar quem já tem conta como administrador que atende cria o perfil clínico já no convite', async () => {
    const { headers } = await setupUser();
    const other = await createUser(await createClinic());
    const res = await api().post('/api/users').set(headers).send({ name: 'Xis', email: other.email, role: 'admin', attendsPatients: true });
    expect(res.body).toMatchObject({ invitePending: true, attendsPatients: true });
  });

  it('na agenda: inicia e conclui os próprios atendimentos, retifica a própria evolução; não mexe no atendimento de outro dentista', async () => {
    const owner = await setupUser();
    const own = await enableAttends(owner.user, owner.clinic);
    const other = await createDentist(owner.clinic);
    const patient = await createPatient(owner.clinic);
    const procedure = await createProcedure(owner.clinic);
    const book = async (dentistId, h) => (await api().post('/api/appointments').set(owner.headers).send({ patientId: patient.id, dentistId, startsAt: T(h), endsAt: T(h + 1) })).body;
    const status = (id, body) => api().post(`/api/appointments/${id}/status`).set(owner.headers).send(body);

    const mine = await book(own.id, 9);
    expect((await status(mine.id, { status: 'in_progress' })).status).toBe(200);
    const done = await status(mine.id, { status: 'attended', evolution: { procedures: [{ procedureId: procedure.id, teeth: [16] }] } });
    expect(done.status).toBe(200);
    const [evolution] = (await api().get(`/api/patients/${patient.id}/evolutions`).set(owner.headers)).body.data;
    expect(evolution).toMatchObject({ canAmend: true });
    const addendum = await api().post(`/api/patients/${patient.id}/evolutions/${evolution.id}/addendum`).set(owner.headers).send({ description: 'Correção do próprio registro' });
    expect(addendum.status).toBe(201);

    const theirs = await book(other.dentist.id, 11);
    const blocked = await status(theirs.id, { status: 'in_progress' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('Só o dentista deste atendimento pode iniciá-lo ou concluí-lo.');
    // como administrador, continua vendo a agenda inteira
    expect((await api().get('/api/appointments').set(owner.headers)).body.data).toHaveLength(2);

    // desligou o atendimento: não retifica mais nem inicia atendimentos
    await api().patch(`/api/users/${owner.user.id}`).set(owner.headers).send({ attendsPatients: false });
    const after = await api().post(`/api/patients/${patient.id}/evolutions/${evolution.id}/addendum`).set(owner.headers).send({ description: 'Mais uma correção' });
    expect(after.status).toBe(403);
    expect((await status(theirs.id, { status: 'in_progress' })).body.error).toBe('Só o dentista inicia o atendimento.');
  });

  it('o backoffice conta quem atende (dentistas e administradores que atendem) e os perfis', async () => {
    const owner = await setupUser();
    await enableAttends(owner.user, owner.clinic);
    await createDentist(owner.clinic);
    await createUser(owner.clinic, { role: 'secretary' });
    await createUser(owner.clinic, { role: 'secretary', active: false });
    const { headers } = await platformSession();
    const res = await api().get(`/api/platform/clinics/${owner.clinic.id}`).set(headers);
    expect(res.body.usage).toMatchObject({ dentists: 2, admins: 1, secretaries: 1 });
  });
});

describe('cadastro de clínica por quem já tem conta', () => {
  const signupBody = (admin) => ({ clinicName: 'Consultório Próprio', template: 'empty', acceptTerms: true, admin });

  it('cadastro público com o mesmo e-mail e a mesma senha: a clínica nova entra na conta da pessoa', async () => {
    const { user, clinic } = await setupUser({ role: 'dentist' });
    const res = await api().post('/api/signup').send(signupBody({ name: 'Nome Ignorado', email: user.email, password: PASSWORD, attendsPatients: true }));
    expect(res.status).toBe(201);
    expect(res.body.admin).toMatchObject({ id: user.id, name: user.name, role: 'admin', attendsPatients: true, invitePending: false, emailVerified: true });
    expect(res.body.message).toContain('senha que você já usa');
    expect(sendVerificationEmail).not.toHaveBeenCalled();
    const choose = await login({ email: user.email, password: PASSWORD });
    expect(choose.body.clinics.map((c) => c.id).sort()).toEqual([clinic.id, res.body.clinic.id].sort());
    expect((await db('terms_acceptances').first()).user_id).toBe(user.id);
  });

  it('quem ainda não confirmou o e-mail recebe a verificação ao criar a clínica', async () => {
    const user = await createUser(await createClinic(), { email_verified_at: null });
    const res = await api().post('/api/signup').send(signupBody({ name: 'Ana', email: user.email, password: PASSWORD }));
    expect(res.status).toBe(201);
    expect(res.body.message).toContain('link de confirmação');
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it('pela plataforma, e-mail que já tem conta vira convite (a plataforma não conhece a senha da pessoa)', async () => {
    const user = await createUser(await createClinic());
    const { headers } = await platformSession();
    const res = await api().post('/api/platform/clinics').set(headers).send({ name: 'Clínica Nova', admin: { name: 'Qualquer', email: user.email, password: 'senha-qualquer-1' } });
    expect(res.status).toBe(201);
    expect(res.body.admin).toMatchObject({ id: user.id, invitePending: true });
    expect(sendInviteEmail.mock.calls[0][0]).toMatchObject({ to: user.email, clinicName: 'Clínica Nova', role: 'admin' });
    expect(sendVerificationEmail).not.toHaveBeenCalled();
    expect((await api().post('/api/auth/accept-invite').send({ token: lastInviteToken() })).status).toBe(200);
    expect((await login({ email: user.email, password: PASSWORD })).body.clinicSelectionRequired).toBe(true);
  });

  it('a plataforma também cria a clínica com o administrador que atende', async () => {
    const { headers } = await platformSession();
    const res = await api().post('/api/platform/clinics').set(headers).send({ name: 'Clínica Solo', admin: { name: 'Dr. Solo', email: 'solo@x.com', password: 'senha-do-solo-1', attendsPatients: true } });
    expect(res.body.admin).toMatchObject({ attendsPatients: true, invitePending: false });
  });
});

describe('exportação (LGPD) com pessoas em mais de uma clínica', () => {
  it('leva as pessoas da equipe e os vínculos da clínica, sem senhas e sem nada da outra clínica', async () => {
    const { a, b, person } = await twoClinics();
    const adminA = await setupUser({ clinic: a });
    const outsider = await createUser(b);
    const res = await api().get('/api/account/export').set(adminA.headers);
    const ids = res.body.tables.users.map((u) => u.id).sort();
    expect(ids).toEqual([person.id, adminA.user.id].sort());
    expect(ids).not.toContain(outsider.id);
    expect(res.body.tables.users[0].password_hash).toBeUndefined();
    expect(res.body.tables.memberships.every((m) => m.clinic_id === a.id)).toBe(true);
  });
});
