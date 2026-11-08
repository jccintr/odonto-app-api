import { withTenant } from '../../db/tenant.js';
import { recordAudit } from '../../services/audit.js';
import { forbidden, notFound, unprocessable } from '../../utils/errors.js';
import { toAddendumDto, toEvolutionDto } from '../../utils/dto.js';
import { pageResult, paginate } from '../../utils/pagination.js';
import { performItemsDuringAppointment } from '../budgets/budgets.service.js';

const dedupe = (rows) => [...new Map(rows.map((row) => [`${row.procedureId}:${row.tooth ?? 'boca'}:${row.budgetItemId ?? ''}`, row])).values()];

/**
 * Registra a evolução do atendimento (chamado ao marcar como atendido, na mesma transação).
 * Os procedimentos escolhidos entram no registro; os itens de orçamento informados recebem baixa.
 */
export async function createEvolution(trx, auth, appointment, { description, procedures, budgetItems }) {
  const ids = [...new Set(procedures.map((p) => p.procedureId))];
  const found = ids.length ? await trx('procedures').whereIn('id', ids).select('id', 'name', 'active') : [];
  const byId = new Map(found.map((row) => [row.id, row]));
  for (const id of ids) {
    const procedure = byId.get(id);
    if (!procedure) throw notFound('Procedimento');
    if (!procedure.active) throw unprocessable(`O procedimento "${procedure.name}" está desativado.`);
  }
  const fromBudget = await performItemsDuringAppointment(trx, auth, { patientId: appointment.patient_id, items: budgetItems, dentistId: appointment.dentist_id });
  const items = dedupe([
    ...procedures.flatMap((p) => {
      const base = { procedureId: p.procedureId, procedureName: byId.get(p.procedureId).name, faces: null, budgetItemId: null };
      return p.wholeMouth ? [{ ...base, tooth: null, wholeMouth: true }] : p.teeth.map((tooth) => ({ ...base, tooth, wholeMouth: false }));
    }),
    ...fromBudget,
  ]);

  const [evolution] = await trx('evolutions')
    .insert({ clinic_id: auth.clinicId, patient_id: appointment.patient_id, dentist_id: appointment.dentist_id, appointment_id: appointment.id, kind: 'evolution', description: description ?? null, created_by: auth.userId })
    .returning('*');
  // a validação garante ao menos um procedimento (do catálogo ou de item de orçamento)
  await trx('evolution_items').insert(items.map((i) => ({
    clinic_id: auth.clinicId, evolution_id: evolution.id, procedure_id: i.procedureId, procedure_name: i.procedureName, tooth: i.tooth, whole_mouth: i.wholeMouth, faces: i.faces, budget_item_id: i.budgetItemId,
  })));
  await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'evolution', entityId: evolution.id, action: 'create' });
}

const baseQuery = (trx) =>
  trx('evolutions')
    .join('dentists', 'dentists.id', 'evolutions.dentist_id')
    .join('users', 'users.id', 'dentists.user_id')
    .select('evolutions.*', 'users.name as dentist_name', 'users.id as dentist_user_id');

async function assertPatient(trx, patientId) {
  if (!(await trx('patients').where({ id: patientId }).first('id'))) throw notFound('Paciente');
}

/** Prontuário do paciente: evoluções da mais recente para a mais antiga, cada uma com os itens e as retificações. */
export function listEvolutions(auth, patientId, filters) {
  return withTenant(auth.clinicId, async (trx) => {
    await assertPatient(trx, patientId);
    const where = { 'evolutions.patient_id': patientId, 'evolutions.kind': 'evolution' };
    const [{ count }] = await trx('evolutions').where({ patient_id: patientId, kind: 'evolution' }).count({ count: '*' });
    const { limit, offset } = paginate(filters);
    const rows = await baseQuery(trx)
      .leftJoin('appointments', 'appointments.id', 'evolutions.appointment_id')
      .where(where)
      .select('appointments.starts_at as appointment_starts_at')
      .orderBy('evolutions.created_at', 'desc').orderBy('evolutions.id').limit(limit).offset(offset);
    const ids = rows.map((r) => r.id);
    const items = ids.length ? await trx('evolution_items').whereIn('evolution_id', ids).orderBy('procedure_name') : [];
    const addenda = ids.length ? await baseQuery(trx).whereIn('evolutions.parent_id', ids).orderBy('evolutions.created_at') : [];
    await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'patient', entityId: patientId, action: 'read', changes: { section: 'evolutions' } });
    const data = rows.map((row) => toEvolutionDto({ ...row, can_amend: row.dentist_user_id === auth.userId }, items.filter((i) => i.evolution_id === row.id), addenda.filter((a) => a.parent_id === row.id)));
    return pageResult(data, Number(count), filters);
  });
}

/** Retificação: o registro original nunca muda; o dentista que o fez acrescenta uma correção ligada a ele. */
export function addAddendum(auth, patientId, evolutionId, { description }) {
  return withTenant(auth.clinicId, async (trx) => {
    const original = await trx('evolutions').where({ id: evolutionId, patient_id: patientId, kind: 'evolution' }).first();
    if (!original) throw notFound('Evolução');
    const own = await trx('dentists').where({ user_id: auth.userId }).first('id');
    if (!own || own.id !== original.dentist_id) throw forbidden('Só o dentista que fez o registro pode retificá-lo.');
    const [row] = await trx('evolutions')
      .insert({ clinic_id: auth.clinicId, patient_id: patientId, dentist_id: own.id, parent_id: original.id, kind: 'addendum', description, created_by: auth.userId })
      .returning('*');
    await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'evolution', entityId: row.id, action: 'create', changes: { addendumTo: original.id } });
    return toAddendumDto({ ...row, dentist_name: (await trx('users').where({ id: auth.userId }).first('name')).name });
  });
}
