import db from '../../src/db/knex.js';
import { signAccessToken } from '../../src/services/tokens.js';
import { createClinic, createDentist, createPatient, createProcedure, createUser } from './factories.js';

/**
 * Uma clínica completa (usuários dos 3 perfis, 2 dentistas, paciente, procedimento, orçamento aprovado com item pendente,
 * atendimento, pagamento e marcação de odontograma para CADA dentista). Todo texto sensível leva "SEGREDO-<label>-", para os testes
 * conseguirem provar que nada de uma clínica aparece em respostas para outra.
 */
export async function buildClinic(label) {
  const clinic = await createClinic({ name: `SEGREDO-${label}-clinica` });
  const mk = (role, name) => createUser(clinic, { role, name: `SEGREDO-${label}-${name}`, email: `${name}.${label}@seg.test` });
  const dent = (name) => createDentist(clinic, { name: `SEGREDO-${label}-${name}`, email: `${name}.${label}@seg.test` });
  const admin = await mk('admin', 'admin');
  const secretary = await mk('secretary', 'secretaria');
  const target = await mk('secretary', 'alvo');
  const d1 = await dent('dentista1');
  const d2 = await dent('dentista2');
  const patient = await createPatient(clinic, { name: `SEGREDO-${label}-paciente`, anamnesis: { nota: `SEGREDO-${label}-anamnese` } });
  const procedure = await createProcedure(clinic, { name: `SEGREDO-${label}-procedimento`, odontogram_condition: 'restoration' });

  const ownedBy = async (dentist, day) => {
    const base = { clinic_id: clinic.id, patient_id: patient.id };
    const [budget] = await db('budgets').insert({ ...base, dentist_id: dentist.dentist.id, status: 'approved', notes: `SEGREDO-${label}-orcamento` }).returning('*');
    const [approval] = await db('budget_approvals').insert({ clinic_id: clinic.id, budget_id: budget.id }).returning('*');
    const [item] = await db('budget_items').insert({ clinic_id: clinic.id, budget_id: budget.id, approval_id: approval.id, procedure_id: procedure.id, tooth: 16, price_cents: 10000, position: 1 }).returning('*');
    const [appointment] = await db('appointments')
      .insert({ ...base, dentist_id: dentist.dentist.id, starts_at: `2099-01-0${day}T10:00:00Z`, ends_at: `2099-01-0${day}T11:00:00Z`, notes: `SEGREDO-${label}-consulta` })
      .returning('*');
    const [payment] = await db('payments').insert({ ...base, budget_id: budget.id, approval_id: approval.id, amount_cents: 5000, due_date: '2099-03-01', notes: `SEGREDO-${label}-pagamento` }).returning('*');
    return { budget, approval, item, appointment, payment };
  };
  const first = await ownedBy(d1, 1);
  const second = await ownedBy(d2, 2);
  const [record] = await db('tooth_records')
    .insert({ clinic_id: clinic.id, patient_id: patient.id, tooth: 11, condition: 'crown', recorded_by: admin.id, notes: `SEGREDO-${label}-dente` })
    .returning('*');

  // prontuário: evolução do atendimento do dentista 1, com um procedimento
  const [evolution] = await db('evolutions')
    .insert({ clinic_id: clinic.id, patient_id: patient.id, dentist_id: d1.dentist.id, appointment_id: first.appointment.id, kind: 'evolution', description: `SEGREDO-${label}-evolucao`, created_by: d1.user.id })
    .returning('*');
  await db('evolution_items').insert({ clinic_id: clinic.id, evolution_id: evolution.id, procedure_id: procedure.id, procedure_name: `SEGREDO-${label}-procedimento`, tooth: 16 });

  const [image] = await db('patient_images')
    .insert({
      clinic_id: clinic.id, patient_id: patient.id, kind: 'xray', public_id: `odontoapp/${clinic.id}/${patient.id}/8f14e45f-ceea-467a-9575-8f2d0f6e0b11`,
      format: 'jpg', bytes: 120000, taken_on: '2026-01-10', notes: `SEGREDO-${label}-radiografia`, uploaded_by: admin.id,
    })
    .returning('*');

  const [notification] = await db('notifications')
    .insert({
      clinic_id: clinic.id, patient_id: patient.id, kind: 'appointment_reminder', appointment_id: first.appointment.id, trigger: 'manual',
      recipient: `SEGREDO-${label}@paciente.test`, subject: `SEGREDO-${label}-aviso`, status: 'sent', attempts: 1, sent_at: new Date(),
    })
    .returning('*');

  // repasse: uma regra (dentista 2 no procedimento) e um fechamento pago ao dentista 1, com o lançamento do procedimento dele
  const [rule] = await db('payout_rules').insert({ clinic_id: clinic.id, procedure_id: procedure.id, dentist_id: d2.dentist.id, type: 'fixed', fixed_cents: 1500 }).returning('*');
  const [entry] = await db('payout_entries')
    .insert({
      clinic_id: clinic.id, budget_id: first.budget.id, item_id: first.item.id, patient_id: patient.id, dentist_id: d1.dentist.id,
      performed_at: new Date(), gross_cents: 10000, cost_cents: 0, base_cents: 10000, rule_source: 'clinic_default', rule_type: 'percent',
      rule_percent: 30, commission_cents: 3000, terms: JSON.stringify({ releaseOn: 'procedure', deductCardFees: false, creditCardFeePercent: 0, debitCardFeePercent: 0 }),
    })
    .returning('*');
  const [payout] = await db('payouts')
    .insert({ clinic_id: clinic.id, dentist_id: d1.dentist.id, until: '2099-01-31', total_cents: 1000, method: 'pix', paid_at: new Date(), notes: `SEGREDO-${label}-repasse` })
    .returning('*');
  await db('payout_lines').insert({ clinic_id: clinic.id, payout_id: payout.id, entry_id: entry.id, amount_cents: 1000 });

  // assinatura: plano escolhido e uma fatura em aberto
  const plan = await db('plans').where({ code: 'clinica' }).first();
  const subscription = await db('subscriptions').where({ clinic_id: clinic.id }).first();
  await db('subscriptions').where({ id: subscription.id }).update({ plan_id: plan.id });
  const [invoice] = await db('invoices')
    .insert({
      clinic_id: clinic.id, subscription_id: subscription.id, plan_id: plan.id, amount_cents: plan.price_cents,
      period_start: '2099-01-01', period_end: '2099-01-31', due_on: '2099-01-01',
    })
    .returning('*');

  return {
    label, clinic, admin, rule, plan, invoice, entry, payout, image, notification, secretary, target, d1, d2, patient, procedure, record, evolution, ...first, second,
    tokens: { admin: signAccessToken(admin), secretary: signAccessToken(secretary), dentist: signAccessToken(d1.user) },
  };
}

/** Resumo (hash) de todas as linhas de uma clínica em todas as tabelas com clinic_id: serve para provar que nada mudou. */
export async function snapshot(clinicId) {
  const { rows } = await db.raw("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'clinic_id' ORDER BY table_name");
  const result = {};
  for (const { table_name: table } of rows) {
    const { rows: [row] } = await db.raw(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS hash FROM "${table}" t WHERE clinic_id = ?`, [clinicId]);
    result[table] = row.hash;
  }
  const { rows: [clinic] } = await db.raw('SELECT md5(t::text) AS hash FROM clinics t WHERE id = ?', [clinicId]);
  result.clinics = clinic.hash;
  return result;
}
