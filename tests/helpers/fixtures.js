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
    const [item] = await db('budget_items').insert({ clinic_id: clinic.id, budget_id: budget.id, procedure_id: procedure.id, tooth: 16, price_cents: 10000, position: 1 }).returning('*');
    const [appointment] = await db('appointments')
      .insert({ ...base, dentist_id: dentist.dentist.id, starts_at: `2099-01-0${day}T10:00:00Z`, ends_at: `2099-01-0${day}T11:00:00Z`, notes: `SEGREDO-${label}-consulta` })
      .returning('*');
    const [payment] = await db('payments').insert({ ...base, budget_id: budget.id, amount_cents: 5000, due_date: '2099-03-01', notes: `SEGREDO-${label}-pagamento` }).returning('*');
    return { budget, item, appointment, payment };
  };
  const first = await ownedBy(d1, 1);
  const second = await ownedBy(d2, 2);
  const [record] = await db('tooth_records')
    .insert({ clinic_id: clinic.id, patient_id: patient.id, tooth: 11, condition: 'crown', recorded_by: admin.id, notes: `SEGREDO-${label}-dente` })
    .returning('*');

  return {
    label, clinic, admin, secretary, target, d1, d2, patient, procedure, record, ...first, second,
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
