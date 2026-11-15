import request from 'supertest';
import app from '../../src/app.js';
import db from '../../src/db/knex.js';
import { hashPassword } from '../../src/services/password.js';
import { withContract } from './contract.js';

// toda resposta vista pelos testes é conferida contra a documentação (ver helpers/contract.js)
export const api = () => withContract(request(app));
export const bearer = (token) => ({ Authorization: `Bearer ${token}` });
export const PASSWORD = 'senha-segura-123';

let counter = 0;
const next = () => {
  counter += 1;
  return counter;
};

/** Cria uma clínica direto no banco. */
export async function createClinic(overrides = {}) {
  const n = next();
  const [clinic] = await db('clinics').insert({ name: `Clínica ${n}`, slug: `clinica-${n}`, ...overrides }).returning('*');
  return clinic;
}

/**
 * Cria uma pessoa com vínculo aceito na clínica, direto no banco (senha PASSWORD).
 * `role`, `active` e `accepted_at` são do vínculo; o resto é da pessoa. Devolve a pessoa com os campos do vínculo
 * (clinic_id, role, active, membership_id), como as linhas de membro da aplicação.
 */
export async function createUser(clinic, overrides = {}) {
  const n = next();
  const { password = PASSWORD, role = 'admin', active = true, accepted_at = new Date(), ...rest } = overrides;
  const [user] = await db('users')
    .insert({ name: `Usuário ${n}`, email: `usuario${n}@teste.com`, email_verified_at: new Date(), password_hash: await hashPassword(password), ...rest })
    .returning('*');
  const membership = await addMembership(user, clinic, { role, active, accepted_at });
  return { ...user, clinic_id: clinic.id, role, active, membership_id: membership.id };
}

/** Vincula uma pessoa que já existe a outra clínica (aceito por padrão; `accepted_at: null` = convite pendente). */
export async function addMembership(user, clinic, { role = 'admin', active = true, accepted_at = new Date() } = {}) {
  const [membership] = await db('memberships').insert({ clinic_id: clinic.id, user_id: user.id, role, active, accepted_at }).returning('*');
  return membership;
}

/** Liga o atendimento de pacientes (perfil clínico) de um vínculo, como o administrador que também atende. */
export async function enableAttends(user, clinic = { id: user.clinic_id }) {
  await db('dentists').insert({ clinic_id: clinic.id, user_id: user.id }).onConflict(['clinic_id', 'user_id']).merge({ active: true });
  return db('dentists').where({ clinic_id: clinic.id, user_id: user.id }).first();
}

/** Altera o vínculo de alguém com a clínica (perfil, situação, aceite) direto no banco. */
export const updateMembership = (user, changes, clinicId = user.clinic_id) =>
  db('memberships').where({ user_id: user.id, clinic_id: clinicId }).update(changes);

/** Faz login pela API na clínica do usuário (quem tem mais de uma clínica entra direto nela) e devolve { ...sessão, user }. */
export async function loginAs(user, password = PASSWORD, clinicId = user.clinic_id) {
  const res = await api().post('/api/auth/login').send({ email: user.email, password, clinicId });
  if (res.status !== 200) throw new Error(`login falhou: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Clínica + usuário + sessão prontos para uso. */
export async function setupUser({ role = 'admin', clinic, userOverrides } = {}) {
  const c = clinic ?? (await createClinic());
  const user = await createUser(c, { role, ...userOverrides });
  const session = await loginAs(user);
  return { clinic: c, user, session, token: session.accessToken, headers: bearer(session.accessToken) };
}

export async function createPlatformAdmin(overrides = {}) {
  const n = next();
  const { password = PASSWORD, ...rest } = overrides;
  const [admin] = await db('platform_admins')
    .insert({ name: `Admin ${n}`, email: `admin${n}@plataforma.test`, password_hash: await hashPassword(password), ...rest })
    .returning('*');
  return admin;
}

export async function platformSession(overrides) {
  const admin = await createPlatformAdmin(overrides);
  const res = await api().post('/api/platform/login').send({ email: admin.email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login da plataforma falhou: ${res.status}`);
  return { admin, token: res.body.token, headers: bearer(res.body.token) };
}

/** Paciente criado direto no banco. */
export async function createPatient(clinic, overrides = {}) {
  const n = next();
  const [patient] = await db('patients').insert({ clinic_id: clinic.id, name: `Paciente ${n}`, ...overrides }).returning('*');
  return patient;
}

/** Usuário dentista + perfil profissional (criado pelo gatilho do banco). */
export async function createDentist(clinic, overrides = {}) {
  const user = await createUser(clinic, { role: 'dentist', ...overrides });
  const dentist = await db('dentists').where({ user_id: user.id, clinic_id: clinic.id }).first();
  return { user, dentist };
}

/** Procedimento criado direto no banco. */
export async function createProcedure(clinic, overrides = {}) {
  const n = next();
  const [procedure] = await db('procedures').insert({ clinic_id: clinic.id, name: `Procedimento ${n}`, price_cents: 10000, ...overrides }).returning('*');
  return procedure;
}
