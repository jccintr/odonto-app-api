import { withTenant } from '../../db/tenant.js';
import { notFound } from '../../utils/errors.js';
import { toDentistDto } from '../../utils/dto.js';

// Só entram usuários que hoje têm perfil "dentist" (quem foi rebaixado mantém o histórico, mas sai da lista).
const dentistsQuery = (trx) =>
  trx('dentists')
    .join('users', 'users.id', 'dentists.user_id')
    .where('users.role', 'dentist')
    .select('dentists.*', 'users.name', 'users.email', 'users.active');

export function listDentists(clinicId, { active }) {
  return withTenant(clinicId, async (trx) => {
    const rows = await dentistsQuery(trx)
      .modify((query) => { if (active !== undefined) query.where('users.active', active); })
      .orderBy('users.name');
    return rows.map(toDentistDto);
  });
}

export function getDentist(clinicId, id) {
  return withTenant(clinicId, async (trx) => {
    const row = await dentistsQuery(trx).where('dentists.id', id).first();
    if (!row) throw notFound('Dentista');
    return toDentistDto(row);
  });
}

export function updateDentist(clinicId, id, { payoutPercent, ...rest }) {
  const changes = { ...rest, ...(payoutPercent !== undefined && { payout_percent: payoutPercent }) };
  return withTenant(clinicId, async (trx) => {
    const updated = await trx('dentists').where({ id }).update({ ...changes, updated_at: new Date() });
    if (!updated) throw notFound('Dentista');
    return toDentistDto(await dentistsQuery(trx).where('dentists.id', id).first());
  });
}
