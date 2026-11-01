// Regras compartilhadas sobre dentistas (agenda e orçamentos).
import { notFound, unprocessable } from '../utils/errors.js';

/** O dentista só enxerga e mexe no que é dele: devolve o id do perfil dele (ou null para admin e secretária). */
export async function ownDentistId(trx, auth) {
  if (auth.role !== 'dentist') return null;
  return (await trx('dentists').where({ user_id: auth.userId }).first('id')).id;
}

/** Garante que o dentista existe na clínica, ainda tem perfil dentist e não foi desativado. */
export async function assertActiveDentist(trx, dentistId) {
  const dentist = await trx('dentists')
    .join('users', 'users.id', 'dentists.user_id')
    .where('dentists.id', dentistId)
    .where('users.role', 'dentist')
    .first('users.active');
  if (!dentist) throw notFound('Dentista');
  if (!dentist.active) throw unprocessable('Este dentista está desativado.');
}
