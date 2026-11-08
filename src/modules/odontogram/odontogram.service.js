import { withTenant } from '../../db/tenant.js';
import { recordAudit } from '../../services/audit.js';
import { notFound } from '../../utils/errors.js';
import { toToothRecordDto } from '../../utils/dto.js';

const assertPatient = async (trx, patientId) => {
  if (!(await trx('patients').where({ id: patientId }).first('id'))) throw notFound('Paciente');
};

/**
 * Camada "planejado": procedimentos com dente ainda não executados, dos orçamentos em aberto ou em tratamento.
 * `approved` diferencia o que o paciente já aprovou do que está só proposto. Não traz valores.
 */
async function plannedByTooth(trx, patientId) {
  const rows = await trx('budget_items')
    .join('budgets', 'budgets.id', 'budget_items.budget_id')
    .join('procedures', 'procedures.id', 'budget_items.procedure_id')
    .where({ 'budgets.patient_id': patientId, 'budget_items.status': 'pending' })
    .whereIn('budgets.status', ['open', 'approved'])
    .whereNotNull('budget_items.tooth')
    .orderBy([{ column: 'budget_items.tooth' }, { column: 'budgets.created_at' }, { column: 'budget_items.position' }])
    .select('budget_items.id', 'budget_items.tooth', 'budget_items.faces', 'budget_items.approval_id', 'procedures.id as procedure_id', 'procedures.name as procedure_name');
  const planned = {};
  for (const row of rows) {
    (planned[row.tooth] ??= []).push({ itemId: row.id, procedure: { id: row.procedure_id, name: row.procedure_name }, faces: row.faces, approved: Boolean(row.approval_id) });
  }
  return planned;
}

/** Odontograma atual: marcações não removidas, agrupadas por dente. Cada leitura é auditada. */
export function getOdontogram(auth, patientId) {
  return withTenant(auth.clinicId, async (trx) => {
    await assertPatient(trx, patientId);
    // quem responde pela marcação: o dentista que executou o procedimento (automática) ou quem a marcou (manual)
    const rows = await trx('tooth_records as t')
      .leftJoin('users as recorder', 'recorder.id', 't.recorded_by')
      .leftJoin('budget_items as item', 'item.id', 't.source_item_id')
      .leftJoin('dentists as performer', 'performer.id', 'item.performed_by_dentist_id')
      .leftJoin('users as performer_user', 'performer_user.id', 'performer.user_id')
      .where({ 't.patient_id': patientId })
      .whereNull('t.removed_at')
      .orderBy([{ column: 't.tooth' }, { column: 't.recorded_on' }, { column: 't.created_at' }])
      .select('t.*', trx.raw('coalesce(performer_user.name, recorder.name) AS recorded_by_name'));
    await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'odontogram', entityId: patientId, action: 'read' });

    const teeth = {};
    for (const row of rows) (teeth[row.tooth] ??= []).push(toToothRecordDto(row));
    return { patientId, teeth, planned: await plannedByTooth(trx, patientId) };
  });
}

export function addRecord(auth, patientId, { tooth, faces, condition, notes, recordedOn }) {
  return withTenant(auth.clinicId, async (trx) => {
    await assertPatient(trx, patientId);
    const [row] = await trx('tooth_records')
      .insert({ clinic_id: auth.clinicId, patient_id: patientId, tooth, faces, condition, notes, recorded_on: recordedOn, recorded_by: auth.userId })
      .returning('*');
    await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'tooth_record', entityId: row.id, action: 'create' });
    const author = await trx('users').where({ id: auth.userId }).first('name');
    return toToothRecordDto({ ...row, recorded_by_name: author.name });
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
