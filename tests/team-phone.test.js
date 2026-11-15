// Telefone da equipe (administrador, secretária, dentista): é da pessoa, como o nome, e vale em todas as clínicas dela.
import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { PASSWORD, addMembership, api, bearer, createClinic, createUser, loginAs, platformSession, setupUser } from './helpers/factories.js';

const create = (headers, extra = {}) =>
  api().post('/api/users').set(headers).send({ name: 'Maria Souza', email: 'maria@x.com', password: 'senha-da-maria-1', role: 'secretary', ...extra });

describe('telefone ao cadastrar e alterar alguém da equipe', () => {
  it('aceita com máscara e guarda só os dígitos; é opcional', async () => {
    const { headers } = await setupUser();
    const res = await create(headers, { phone: '(35) 99999-0001' });
    expect(res.status).toBe(201);
    expect(res.body.phone).toBe('35999990001');
    expect((await db('users').where({ id: res.body.id }).first()).phone).toBe('35999990001');
    const without = await create(headers, { email: 'sem@x.com' });
    expect(without.body.phone).toBeNull();
    expect((await api().get(`/api/users/${res.body.id}`).set(headers)).body.phone).toBe('35999990001');
  });

  it('telefone inválido: 400 com o campo', async () => {
    const { headers } = await setupUser();
    for (const phone of ['123', '(35) 9999', '1'.repeat(12), 35999990001]) {
      const res = await create(headers, { phone });
      expect(res.status, String(phone)).toBe(400);
      expect(res.body.details[0].field).toBe('phone');
    }
  });

  it('o administrador altera e apaga (null) o telefone', async () => {
    const { headers } = await setupUser();
    const { body: user } = await create(headers);
    const patch = (body) => api().patch(`/api/users/${user.id}`).set(headers).send(body);
    expect((await patch({ phone: '3533331234' })).body.phone).toBe('3533331234');
    expect((await patch({ phone: null })).body.phone).toBeNull();
    expect((await patch({ phone: 'x' })).status).toBe(400);
  });

  it('quem também está em outra clínica: só a própria pessoa altera o telefone (422 SHARED_ACCOUNT)', async () => {
    const { headers, clinic } = await setupUser();
    const shared = await createUser(clinic, { role: 'dentist', phone: '35911112222' });
    await addMembership(shared, await createClinic());
    const res = await api().patch(`/api/users/${shared.id}`).set(headers).send({ phone: '35900000000' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SHARED_ACCOUNT');
    expect((await db('users').where({ id: shared.id }).first()).phone).toBe('35911112222');
  });

  it('convite para quem já tem conta mantém o telefone da pessoa', async () => {
    const { headers } = await setupUser();
    const other = await createUser(await createClinic(), { phone: '35922223333' });
    const res = await create(headers, { email: other.email, phone: '35900000000' });
    expect(res.body).toMatchObject({ invitePending: true, phone: '35922223333' });
  });
});

describe('meu telefone (Minha conta)', () => {
  it('PATCH /api/auth/me altera nome e/ou telefone; null apaga; vale nas outras clínicas', async () => {
    const { headers, user, clinic } = await setupUser();
    const other = await createClinic();
    await addMembership(user, other);
    const me = (body) => api().patch('/api/auth/me').set(headers).send(body);
    expect((await me({ phone: '(35) 98888-7777' })).body.user).toMatchObject({ phone: '35988887777', name: user.name });
    expect((await me({ name: 'Nome Novo', phone: null })).body.user).toMatchObject({ phone: null, name: 'Nome Novo' });
    expect((await me({ phone: '35988887777' })).status).toBe(200);
    const inOther = await loginAs({ ...user, clinic_id: other.id });
    expect(inOther.user.phone).toBe('35988887777');
    expect(inOther.user.clinicId).not.toBe(clinic.id);
  });

  it('corpo vazio ou telefone inválido: 400', async () => {
    const { headers } = await setupUser();
    expect((await api().patch('/api/auth/me').set(headers).send({})).status).toBe(400);
    expect((await api().patch('/api/auth/me').set(headers).send({ phone: '99' })).status).toBe(400);
  });

  it('o telefone volta no login e no perfil', async () => {
    const { clinic } = await setupUser();
    const person = await createUser(clinic, { phone: '3532221111' });
    const session = await loginAs(person, PASSWORD);
    expect(session.user.phone).toBe('3532221111');
    expect((await api().get('/api/auth/me').set(bearer(session.accessToken))).body.user.phone).toBe('3532221111');
  });
});

describe('telefone do primeiro administrador', () => {
  it('no cadastro público e pela plataforma', async () => {
    const signup = await api().post('/api/signup').send({
      clinicName: 'Clínica Fone', template: 'empty', acceptTerms: true,
      admin: { name: 'Dra. Fone', email: 'fone@x.com', password: 'senha-da-fone-1', phone: '(35) 97777-6666' },
    });
    expect(signup.body.admin.phone).toBe('35977776666');
    const { headers } = await platformSession();
    const created = await api().post('/api/platform/clinics').set(headers).send({ name: 'Clínica Plataforma', admin: { name: 'Dr. Plat', email: 'plat@x.com', password: 'senha-do-plat-1', phone: '3533334444' } });
    expect(created.body.admin.phone).toBe('3533334444');
    const noPhone = await api().post('/api/platform/clinics').set(headers).send({ name: 'Clínica Sem Fone', admin: { name: 'Dr. Sem', email: 'sem@x.com', password: 'senha-do-sem-12' } });
    expect(noPhone.body.admin.phone).toBeNull();
  });

  it('o banco recusa telefone fora do formato (proteção além da validação da API)', async () => {
    const user = await createUser(await createClinic());
    await expect(db('users').where({ id: user.id }).update({ phone: '(35) 1234' })).rejects.toThrow(/users_phone_check/);
  });
});
