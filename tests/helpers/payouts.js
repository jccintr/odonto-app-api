// Cenário comum dos testes de repasse: clínica com dois dentistas, um paciente e dois procedimentos.
import { api, createDentist, createPatient, createProcedure, setupUser } from './factories.js';

export async function setup() {
  const admin = await setupUser();
  const dentist = await createDentist(admin.clinic, { name: 'Dr. Paulo' });
  const other = await createDentist(admin.clinic, { name: 'Dra. Bia' });
  const patient = await createPatient(admin.clinic, { name: 'Ana Lima' });
  const filling = await createProcedure(admin.clinic, { name: 'Restauração', price_cents: 20000, cost_cents: 5000 });
  const cleaning = await createProcedure(admin.clinic, { name: 'Limpeza', price_cents: 10000 });
  return { ...admin, dentist, other, patient, filling, cleaning, id: dentist.dentist.id, otherId: other.dentist.id };
}

export const settings = async (c, body) => {
  const res = await api().patch('/api/payouts/settings').set(c.headers).send(body);
  if (res.status !== 200) throw new Error(`settings: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

export const dentistPercent = (c, dentist, payoutPercent) => api().patch(`/api/dentists/${dentist.dentist.id}`).set(c.headers).send({ payoutPercent });

export const rule = async (c, body) => {
  const res = await api().post('/api/payouts/rules').set(c.headers).send(body);
  if (res.status !== 201) throw new Error(`rule: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

/** Orçamento aprovado. items: lista de procedimentos (padrão: uma restauração). */
export async function approvedBudget(c, { procedures = [c.filling], dentistId = c.id, discountCents = 0 } = {}) {
  const created = await api().post('/api/budgets').set(c.headers).send({ patientId: c.patient.id, dentistId, items: procedures.map((p) => ({ procedureId: p.id })) });
  if (discountCents) await api().patch(`/api/budgets/${created.body.id}`).set(c.headers).send({ discountCents });
  const res = await api().post(`/api/budgets/${created.body.id}/status`).set(c.headers).send({ status: 'approved' });
  if (res.status !== 200) throw new Error(`orçamento: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export const perform = (c, budget, index = 0, body = {}, headers = c.headers) =>
  api().post(`/api/budgets/${budget.id}/items/${budget.items[index].id}/perform`).set(headers).send(body);

/** Recebimento imediato. */
export async function receive(c, budget, amountCents, method = 'pix', paidAt = new Date().toISOString()) {
  const res = await api().post(`/api/budgets/${budget.id}/payments`).set(c.headers).send({ amountCents, method, paidAt });
  if (res.status !== 201) throw new Error(`pagamento: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export const entries = async (c, query = '') => (await api().get(`/api/payouts/entries${query}`).set(c.headers)).body;
export const balances = async (c, query = '') => (await api().get(`/api/payouts/balances${query}`).set(c.headers)).body;
export const closePayout = (c, body) => api().post('/api/payouts').set(c.headers).send({ dentistId: c.id, method: 'pix', ...body });
