import { withTenant } from '../../db/tenant.js';
import { patientStanding } from '../../services/standing.js';
import { addDays, businessDate, daysBetween } from '../../utils/dates.js';

const LIMIT = 50;
const ACTIVE = ['scheduled', 'confirmed'];

// consulta marcada para daqui para frente (ainda não começou)
const upcoming = (trx) => trx('appointments').whereIn('status', ACTIVE).where('starts_at', '>=', new Date());

/** Pacientes com procedimento aprovado a realizar e nenhuma consulta marcada: falta agendar. */
async function approvedWithoutAppointment(trx) {
  const rows = await trx('budget_items')
    .join('budgets', 'budgets.id', 'budget_items.budget_id')
    .join('budget_approvals', 'budget_approvals.id', 'budget_items.approval_id')
    .join('patients', 'patients.id', 'budgets.patient_id')
    .where({ 'budget_items.status': 'pending', 'budgets.status': 'approved', 'patients.active': true })
    .whereNotExists(upcoming(trx).whereRaw('appointments.patient_id = patients.id'))
    .groupBy('patients.id', 'patients.name')
    .orderBy('since')
    .limit(LIMIT)
    .select('patients.id', 'patients.name', trx.raw('count(*)::int AS items_count'), trx.raw('min(budget_approvals.created_at) AS since'));
  return rows.map((row) => ({ patient: { id: row.id, name: row.name }, itemsCount: row.items_count, approvedSince: row.since }));
}

/** Orçamentos que o paciente ainda não respondeu (em aberto), os mais antigos primeiro. */
async function budgetsAwaitingAnswer(trx) {
  const totals = trx('budget_items').where('status', '<>', 'canceled').groupBy('budget_id').select('budget_id').sum({ subtotal: 'price_cents' }).count({ items: '*' }).as('totals');
  const rows = await trx('budgets')
    .join('patients', 'patients.id', 'budgets.patient_id')
    .join('dentists', 'dentists.id', 'budgets.dentist_id')
    .join('users', 'users.id', 'dentists.user_id')
    .join(totals, 'totals.budget_id', 'budgets.id')
    .where('budgets.status', 'open')
    .orderBy('budgets.created_at')
    .limit(LIMIT)
    .select('budgets.id', 'budgets.created_at', 'budgets.discount_cents', 'patients.id as patient_id', 'patients.name as patient_name', 'users.name as dentist_name', trx.raw('totals.subtotal::int AS subtotal'));
  const today = businessDate();
  return rows.map((row) => ({
    budgetId: row.id,
    patient: { id: row.patient_id, name: row.patient_name },
    dentistName: row.dentist_name,
    totalCents: Math.max(row.subtotal - row.discount_cents, 0),
    createdAt: row.created_at,
    daysOpen: daysBetween(businessDate(row.created_at), today),
  }));
}

/** Pacientes em atraso além da tolerância que já têm consulta marcada: avisar antes de chegarem. */
async function overdueWithAppointments(trx) {
  const { overdue_grace_days: graceDays } = await trx('clinics').first('overdue_grace_days');
  const limit = addDays(businessDate(), -graceDays);
  const rows = await upcoming(trx)
    .join('patients', 'patients.id', 'appointments.patient_id')
    .join('dentists', 'dentists.id', 'appointments.dentist_id')
    .join('users', 'users.id', 'dentists.user_id')
    .whereExists(trx('payments').whereRaw('payments.patient_id = patients.id').where('payments.status', 'pending').where('payments.due_date', '<', limit))
    .orderBy('appointments.starts_at')
    .select('appointments.id', 'appointments.starts_at', 'patients.id as patient_id', 'patients.name as patient_name', 'users.name as dentist_name');
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    if (seen.has(row.patient_id)) continue; // só a próxima consulta de cada paciente
    seen.add(row.patient_id);
    const standing = await patientStanding(trx, row.patient_id);
    result.push({
      patient: { id: row.patient_id, name: row.patient_name },
      nextAppointment: { id: row.id, startsAt: row.starts_at, dentistName: row.dentist_name },
      overdueCents: standing.overdueCents,
      oldestDueDate: standing.oldestDueDate,
      blocked: standing.blocked,
      releasedUntil: standing.releasedUntil,
    });
  }
  return result.slice(0, LIMIT);
}

export const getWorklist = (clinicId) =>
  withTenant(clinicId, async (trx) => ({
    approvedWithoutAppointment: await approvedWithoutAppointment(trx),
    budgetsAwaitingAnswer: await budgetsAwaitingAnswer(trx),
    overdueWithAppointments: await overdueWithAppointments(trx),
  }));
