import { withTenant } from '../../db/tenant.js';
import { recordAudit } from '../../services/audit.js';
import { notFound } from '../../utils/errors.js';
import { toToothRecordDto } from '../../utils/dto.js';

const assertPatient = async (trx, patientId) => {
  if (!(await trx('patients').where({ id: patientId }).first('id'))) throw notFound('Paciente');
};

/** Odontograma atual: marcações não removidas, agrupadas por dente. Cada leitura é auditada. */
export function getOdontogram(auth, patientId) {
  return withTenant(auth.clinicId, async (trx) => {
    await assertPatient(trx, patientId);
    const rows = await trx('tooth_records')
      .where({ patient_id: patientId })
      .whereNull('removed_at')
      .orderBy([{ column: 'tooth' }, { column: 'recorded_on' }, { column: 'created_at' }]);
    await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'odontogram', entityId: patientId, action: 'read' });

    const teeth = {};
    for (const row of rows) (teeth[row.tooth] ??= []).push(toToothRecordDto(row));
    return { patientId, teeth };
  });
}

export function addRecord(auth, patientId, { tooth, faces, condition, notes, recordedOn }) {
  return withTenant(auth.clinicId, async (trx) => {
    await assertPatient(trx, patientId);
    const [row] = await trx('tooth_records')
      .insert({ clinic_id: auth.clinicId, patient_id: patientId, tooth, faces, condition, notes, recorded_on: recordedOn, recorded_by: auth.userId })
      .returning('*');
    await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'tooth_record', entityId: row.id, action: 'create' });
    return toToothRecordDto(row);
  });
}

/** Nada é apagado: a marcação fica no banco como removida, com quem removeu e quando. */
export function removeRecord(auth, patientId, recordId) {
  return withTenant(auth.clinicId, async (trx) => {
    const updated = await trx('tooth_records')
      .where({ id: recordId, patient_id: patientId })
      .whereNull('removed_at')
      .update({ removed_at: new Date(), removed_by: auth.userId });
    if (!updated) throw notFound('Marcação');
    await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'tooth_record', entityId: recordId, action: 'remove' });
  });
}
