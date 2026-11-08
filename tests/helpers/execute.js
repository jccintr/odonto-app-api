// Dá baixa em itens de orçamento pelo caminho real (o único que existe): marca o atendimento, o dentista inicia e conclui informando os itens.
import db from '../../src/db/knex.js';
import { api, bearer, loginAs } from './factories.js';

const sessions = new WeakMap();
/** Cabeçalhos de login do usuário (uma sessão por usuário, reaproveitada). */
export async function headersOf(user) {
  if (!sessions.has(user)) sessions.set(user, bearer((await loginAs(user)).accessToken));
  return sessions.get(user);
}

let slot = 0;
// cada chamada ganha um horário próprio (no futuro e sem choque com outros atendimentos do mesmo teste)
const nextSlot = () => {
  const start = new Date(Date.UTC(2090, 0, 1) + slot++ * 3_600_000);
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 1_800_000).toISOString() };
};

/**
 * Executa os itens `indexes` do orçamento com o dentista `dentist` ({ user, dentist }). Devolve a primeira resposta que falhar,
 * ou a da conclusão do atendimento. `performedAt` (opcional) recua a data da execução, para testes de período.
 */
export async function execute({ admin, dentist, budget, indexes = [0], performedAt }) {
  const created = await api().post('/api/appointments').set(admin).send({ patientId: budget.patient.id, dentistId: dentist.dentist.id, ...nextSlot() });
  if (created.status !== 201) return created;
  const headers = await headersOf(dentist.user);
  const status = (body) => api().post(`/api/appointments/${created.body.id}/status`).set(headers).send(body);
  const started = await status({ status: 'in_progress' });
  if (started.status !== 200) return started;
  const budgetItems = indexes.map((i) => (budget.items[i].tooth ? { itemId: budget.items[i].id } : { itemId: budget.items[i].id, wholeMouth: true }));
  const res = await status({ status: 'attended', evolution: { budgetItems } });
  if (res.status === 200 && performedAt) {
    const ids = indexes.map((i) => budget.items[i].id);
    await db('budget_items').whereIn('id', ids).update({ performed_at: performedAt });
    await db('payout_entries').whereIn('item_id', ids).update({ performed_at: performedAt });
  }
  return res;
}
