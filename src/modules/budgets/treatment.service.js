import { withTenant } from '../../db/tenant.js';
import { notFound } from '../../utils/errors.js';

/**
 * Procedimentos "a realizar" do paciente: aprovados por ele e ainda não executados, de todos os orçamentos
 * (de qualquer dentista da clínica). É daqui que o dentista escolhe o que fazer no atendimento. Não traz valores.
 */
export const listTreatmentItems = (clinicId, patientId) =>
  withTenant(clinicId, async (trx) => {
    if (!(await trx('patients').where({ id: patientId }).first('id'))) throw notFound('Paciente');
    const rows = await trx('budget_items')
      .join('budgets', 'budgets.id', 'budget_items.budget_id')
      .join('budget_approvals', 'budget_approvals.id', 'budget_items.approval_id')
      .join('procedures', 'procedures.id', 'budget_items.procedure_id')
      .join('dentists', 'dentists.id', 'budgets.dentist_id')
      .join('users', 'users.id', 'dentists.user_id')
      .where({ 'budgets.patient_id': patientId, 'budget_items.status': 'pending', 'budgets.status': 'approved' })
      .orderBy([{ column: 'budget_approvals.created_at' }, { column: 'budget_items.position' }])
      .select('budget_items.*', 'procedures.name as procedure_name', 'users.name as dentist_name', 'budgets.dentist_id', 'budget_approvals.created_at as approved_on');
    return {
      data: rows.map((row) => ({
        itemId: row.id,
        budgetId: row.budget_id,
        dentist: { id: row.dentist_id, name: row.dentist_name },
        procedure: { id: row.procedure_id, name: row.procedure_name },
        tooth: row.tooth,
        faces: row.faces,
        approvedAt: row.approved_on,
      })),
    };
  });
