import { withTenant } from '../../db/tenant.js';
import { conflict, HttpError, notFound } from '../../utils/errors.js';
import { toUserDto } from '../../utils/dto.js';
import { escapeLike, pageResult, paginate } from '../../utils/pagination.js';
import { hashPassword } from '../../services/password.js';
import { revokeAllUserTokens, sendVerificationSafely } from '../auth/auth.service.js';

const filtered = (trx, { role, active, q }) =>
  trx('users').modify((query) => {
    if (role) query.where({ role });
    if (active !== undefined) query.where({ active });
    if (q) query.where((b) => b.whereILike('name', `%${escapeLike(q)}%`).orWhereILike('email', `%${escapeLike(q)}%`));
  });

export function listUsers(clinicId, filters) {
  return withTenant(clinicId, async (trx) => {
    const [{ count }] = await filtered(trx, filters).count({ count: '*' });
    const rows = await filtered(trx, filters).orderBy('name').limit(paginate(filters).limit).offset(paginate(filters).offset);
    return pageResult(rows.map(toUserDto), Number(count), filters);
  });
}

export function getUser(clinicId, id) {
  return withTenant(clinicId, async (trx) => {
    const user = await trx('users').where({ id }).first();
    if (!user) throw notFound('Usuário');
    return toUserDto(user);
  });
}

export async function createUser(clinicId, { name, email, password, role }) {
  const passwordHash = await hashPassword(password);
  let user;
  try {
    [user] = await withTenant(clinicId, (trx) =>
      trx('users').insert({ clinic_id: clinicId, name, email, password_hash: passwordHash, role }).returning('*'));
  } catch (err) {
    if (err.code === '23505') throw conflict('E-mail já cadastrado.');
    throw err;
  }
  await sendVerificationSafely(user);
  return toUserDto(user);
}

export function updateUser(clinicId, actorId, id, changes) {
  // quem administra não pode se desativar nem se rebaixar: a clínica nunca fica sem administrador
  if (id === actorId && (changes.active === false || (changes.role && changes.role !== 'admin'))) {
    throw new HttpError(422, 'Você não pode desativar nem alterar o próprio perfil.');
  }
  return withTenant(clinicId, async (trx) => {
    const [user] = await trx('users').where({ id }).update({ ...changes, updated_at: new Date() }).returning('*');
    if (!user) throw notFound('Usuário');
    if (changes.active === false) await revokeAllUserTokens(id, trx);
    return toUserDto(user);
  });
}
