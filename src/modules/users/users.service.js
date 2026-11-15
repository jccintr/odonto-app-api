// Usuários da clínica = vínculos (memberships) de pessoas com a clínica. A pessoa (nome, e-mail, senha) é uma só no sistema:
// quem já tem conta em outra clínica recebe um convite em vez de uma conta nova, e continua com a mesma senha.
import { randomUUID } from 'node:crypto';
import db from '../../db/knex.js';
import { withTenant } from '../../db/tenant.js';
import { badRequest, conflict, HttpError, notFound, tooManyRequests, unprocessable } from '../../utils/errors.js';
import { toUserDto } from '../../utils/dto.js';
import { escapeLike, pageResult, paginate } from '../../utils/pagination.js';
import { hashPassword } from '../../services/password.js';
import { findMember, isClinical, membersBase, membersQuery, setClinicalProfile } from '../../services/members.js';
import { assertDentistSlot } from '../billing/limits.js';
import { revokeClinicSessions, sendInviteSafely, sendVerificationSafely } from '../auth/auth.service.js';
import { cooldownRemaining } from '../auth/auth.tokens.js';

const filtered = (query, { role, active, q }) =>
  query.modify((b) => {
    if (role) b.where('memberships.role', role);
    if (active !== undefined) b.where('memberships.active', active);
    if (q) b.where((w) => w.whereILike('users.name', `%${escapeLike(q)}%`).orWhereILike('users.email', `%${escapeLike(q)}%`));
  });

export function listUsers(clinicId, filters) {
  return withTenant(clinicId, async (trx) => {
    const [{ count }] = await filtered(membersBase(trx), filters).count({ count: '*' });
    const { limit, offset } = paginate(filters);
    const rows = await filtered(membersQuery(trx), filters).orderBy('users.name').limit(limit).offset(offset);
    return pageResult(rows.map(toUserDto), Number(count), filters);
  });
}

export function getUser(clinicId, id) {
  return withTenant(clinicId, async (trx) => {
    const member = await findMember(trx, id, clinicId);
    if (!member) throw notFound('Usuário');
    return toUserDto(member);
  });
}

/** Atende pacientes depois da mudança? Dentista sempre; secretária nunca; administrador, se quiser (`requested`, ou mantém o atual). */
function resolveAttends(role, requested, current) {
  if (role === 'dentist') {
    if (requested === false) throw unprocessable('Dentista sempre atende pacientes. Para deixar de atender, mude o perfil.', { code: 'INVALID_ATTENDS' });
    return true;
  }
  if (role === 'secretary') {
    if (requested === true) throw unprocessable('Secretária não atende pacientes. Use o perfil de administrador ou de dentista.', { code: 'INVALID_ATTENDS' });
    return false;
  }
  return requested ?? current;
}

const clinicOf = (trx) => trx('clinics').first('id', 'name');

/** Pessoa que já tem conta: cria o vínculo pendente e envia o convite (ela aceita pelo link e entra com a senha que já usa). */
async function invite(clinicId, actorId, userId, role, attends) {
  const { member, clinic } = await withTenant(clinicId, async (trx) => {
    if (await trx('memberships').where({ user_id: userId }).first('id')) {
      throw conflict('Este e-mail já está cadastrado nesta clínica.', { code: 'ALREADY_MEMBER' });
    }
    if (attends) await assertDentistSlot(trx);
    await trx('memberships').insert({ clinic_id: clinicId, user_id: userId, role, invited_by: actorId });
    if (attends) await setClinicalProfile(trx, clinicId, userId, true);
    return { member: await findMember(trx, userId, clinicId), clinic: await clinicOf(trx) };
  });
  await sendInviteSafely(member, clinic);
  return toUserDto(member);
}

/**
 * Cadastra alguém na clínica. E-mail novo: cria a pessoa (com a senha inicial) e o vínculo, e envia a verificação de e-mail.
 * E-mail que já tem conta (de outra clínica): só convida (vínculo pendente até aceitar). A senha e o telefone informados são ignorados
 * (são da pessoa, que já tem os dela).
 */
export async function createUser(clinicId, actorId, { name, email, password, role, phone = null, attendsPatients }) {
  const attends = resolveAttends(role, attendsPatients, false);
  const existing = await db('users').where({ email }).first('id');
  if (existing) return invite(clinicId, actorId, existing.id, role, attends);
  if (!password) {
    throw badRequest('Informe a senha inicial.', { details: [{ field: 'password', message: 'Informe a senha inicial (o e-mail ainda não tem conta no OdontoApp).' }] });
  }

  const passwordHash = await hashPassword(password);
  const id = randomUUID();
  // o e-mail é único no banco: numa corrida rara entre dois cadastros do mesmo e-mail, o segundo falha em vez de duplicar a pessoa
  const member = await withTenant(clinicId, async (trx) => {
    if (attends) await assertDentistSlot(trx);
    await trx('users').insert({ id, name, email, phone, password_hash: passwordHash });
    await trx('memberships').insert({ clinic_id: clinicId, user_id: id, role, accepted_at: new Date(), invited_by: actorId });
    if (attends) await setClinicalProfile(trx, clinicId, id, true);
    return findMember(trx, id, clinicId);
  });
  await sendVerificationSafely(member);
  return toUserDto(member);
}

export function updateUser(clinicId, actorId, id, changes) {
  // quem administra não pode se desativar nem se rebaixar: a clínica nunca fica sem administrador
  if (id === actorId && (changes.active === false || (changes.role && changes.role !== 'admin'))) {
    throw new HttpError(422, 'Você não pode desativar nem alterar o próprio perfil.');
  }
  return withTenant(clinicId, async (trx) => {
    const current = await findMember(trx, id, clinicId);
    if (!current) throw notFound('Usuário');
    // nome e telefone são da pessoa: se ela também está em outra clínica, só ela altera (em "Minha conta"), para uma clínica não mudar os dados na outra
    const personal = { ...(changes.name !== undefined && { name: changes.name }), ...(changes.phone !== undefined && { phone: changes.phone }) };
    if (Object.keys(personal).length > 0 && (await db('memberships').where({ user_id: id }).whereNot({ clinic_id: clinicId }).first('id'))) {
      throw unprocessable('Este profissional também tem acesso a outra clínica: só ele pode alterar o próprio nome e telefone (em Minha conta).', { code: 'SHARED_ACCOUNT' });
    }

    const role = changes.role ?? current.role;
    const active = changes.active ?? current.active;
    const attends = resolveAttends(role, changes.attendsPatients, Boolean(current.dentist_id));
    // passar a atender (virar dentista, ligar o atendimento ou reativar quem atende) respeita o limite de dentistas do plano
    if (active && attends && !isClinical(current)) await assertDentistSlot(trx);

    const now = new Date();
    await trx('memberships').where({ user_id: id }).update({ role, active, updated_at: now });
    if (Object.keys(personal).length > 0) await trx('users').where({ id }).update({ ...personal, updated_at: now });
    await setClinicalProfile(trx, clinicId, id, attends);
    if (changes.active === false) await revokeClinicSessions(id, clinicId, trx);
    return toUserDto(await findMember(trx, id, clinicId));
  });
}

/** Reenvia o convite de quem ainda não aceitou. */
export async function resendInvite(clinicId, id) {
  const { member, clinic } = await withTenant(clinicId, async (trx) => {
    const found = await findMember(trx, id, clinicId);
    if (!found) throw notFound('Usuário');
    if (found.accepted_at) throw conflict('Este usuário já aceitou o convite.', { code: 'INVITE_ACCEPTED' });
    if (!found.active) throw unprocessable('Este convite foi cancelado (usuário desativado). Reative o usuário para convidá-lo de novo.');
    return { member: found, clinic: await clinicOf(trx) };
  });
  const wait = await cooldownRemaining(id, 'membership_invite', clinicId);
  if (wait > 0) throw tooManyRequests('Aguarde um pouco para reenviar o convite.', wait);
  await sendInviteSafely(member, clinic);
  return { message: 'Convite reenviado.' };
}
