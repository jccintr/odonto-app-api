import { withTenant } from '../../db/tenant.js';
import { recordAudit } from '../../services/audit.js';
import { patientStanding } from '../../services/standing.js';
import { conflict, notFound } from '../../utils/errors.js';

async function assertPatient(trx, patientId) {
  if (!(await trx('patients').where({ id: patientId }).first('id'))) throw notFound('Paciente');
}

export const getStanding = (clinicId, patientId) =>
  withTenant(clinicId, async (trx) => {
    await assertPatient(trx, patientId);
    return patientStanding(trx, patientId);
  });

/** O administrador libera, com motivo e por alguns dias, um paciente bloqueado. */
export const releaseBlock = (auth, patientId, { reason, days }) =>
  withTenant(auth.clinicId, async (trx) => {
    await assertPatient(trx, patientId);
    if (!(await patientStanding(trx, patientId)).blocked) throw conflict('Este paciente não está bloqueado.', { code: 'NOT_BLOCKED' });
    const [{ id }] = await trx('block_releases')
      .insert({ clinic_id: auth.clinicId, patient_id: patientId, reason, valid_until: new Date(Date.now() + days * 86_400_000), released_by: auth.userId })
      .returning('id');
    await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'block_release', entityId: id, action: 'create' });
    return patientStanding(trx, patientId);
  });
