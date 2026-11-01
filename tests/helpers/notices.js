// Cenário dos testes de avisos: clínica com dentista, paciente contactável e atendimentos em horários relativos a "agora".
import db from '../../src/db/knex.js';
import { api, createDentist, createPatient, createProcedure, setupUser } from './factories.js';

export const HOUR = 3_600_000;

export async function setup({ patient: patientFields = {} } = {}) {
  const admin = await setupUser();
  const dentist = await createDentist(admin.clinic, { name: 'Dr. Paulo' });
  const patient = await createPatient(admin.clinic, {
    name: 'Ana Lima', email: 'ana@exemplo.test', phone: '35999990000', contact_consent: true, ...patientFields,
  });
  const procedure = await createProcedure(admin.clinic, { name: 'Restauração', price_cents: 20000 });
  return { ...admin, dentist, patient, procedure, dentistId: dentist.dentist.id };
}

/** Atendimento que começa daqui a `hours` horas (relativo a `from`, padrão: agora). */
export async function appointmentIn(c, hours, { status = 'scheduled', patient = c.patient, from = Date.now() } = {}) {
  const starts = new Date(from + hours * HOUR);
  const [row] = await db('appointments')
    .insert({ clinic_id: c.clinic.id, patient_id: patient.id, dentist_id: c.dentistId, status, starts_at: starts, ends_at: new Date(starts.getTime() + HOUR) })
    .returning('*');
  return row;
}

/** Orçamento aprovado com as restaurações pedidas (dentes), e desconto opcional. */
export async function budgetWith(c, { teeth = [16], discountCents = 0, patient = c.patient } = {}) {
  const created = await api().post('/api/budgets').set(c.headers).send({
    patientId: patient.id, dentistId: c.dentistId, items: teeth.map((tooth) => ({ procedureId: c.procedure.id, tooth })),
  });
  if (discountCents) await api().patch(`/api/budgets/${created.body.id}`).set(c.headers).send({ discountCents });
  return created.body;
}

export const notifications = (c) => db('notifications').where({ clinic_id: c.clinic.id }).orderBy('created_at');
