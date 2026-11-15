// Regras compartilhadas sobre dentistas (agenda e orçamentos).
import { notFound, unprocessable } from '../utils/errors.js';

/**
 * O perfil dentista só enxerga e mexe no que é dele: devolve o id do perfil clínico dele (ou null para admin e secretária).
 * O administrador que também atende continua vendo tudo, como administrador.
 */
export const ownDentistId = (auth) => (auth.role === 'dentist' ? auth.dentistId : null);

/** Telefone do paciente é da secretária e da administração: o dentista nunca o recebe nem o usa em buscas. */
export const canSeeContact = (auth) => auth.role !== 'dentist';

/** Garante que o dentista existe na clínica, ainda atende e não foi desativado. */
export async function assertActiveDentist(trx, dentistId) {
  const dentist = await trx('dentists')
    .join('memberships', (join) => join.on('memberships.clinic_id', 'dentists.clinic_id').andOn('memberships.user_id', 'dentists.user_id'))
    .where({ 'dentists.id': dentistId, 'dentists.active': true })
    .first('memberships.active');
  if (!dentist) throw notFound('Dentista');
  if (!dentist.active) throw unprocessable('Este dentista está desativado.');
}
