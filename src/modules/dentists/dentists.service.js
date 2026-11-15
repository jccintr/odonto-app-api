import { withTenant } from '../../db/tenant.js';
import { notFound } from '../../utils/errors.js';
import { toDentistDto } from '../../utils/dto.js';

// Quem atende pacientes na clínica: dentistas e administradores com o atendimento ligado.
// Quem deixou de atender (rebaixado ou administrador que desligou) mantém o histórico, mas sai da lista.
// `active` é a situação do vínculo com a clínica (desativado = não entra mais).
const dentistsQuery = (trx) =>
  trx('dentists')
    .join('users', 'users.id', 'dentists.user_id')
    .join('memberships', (join) => join.on('memberships.clinic_id', 'dentists.clinic_id').andOn('memberships.user_id', 'dentists.user_id'))
    .where('dentists.active', true)
    .select(
      'dentists.id', 'dentists.user_id', 'dentists.cro', 'dentists.specialty', 'dentists.color', 'dentists.payout_percent',
      'users.name', 'users.email', 'memberships.role', 'memberships.active',
    );

export function listDentists(clinicId, { active }) {
  return withTenant(clinicId, async (trx) => {
    const rows = await dentistsQuery(trx)
      .modify((query) => { if (active !== undefined) query.where('memberships.active', active); })
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
    const updated = await trx('dentists').where({ id, active: true }).update({ ...changes, updated_at: new Date() });
    if (!updated) throw notFound('Dentista');
    return toDentistDto(await dentistsQuery(trx).where('dentists.id', id).first());
  });
}
