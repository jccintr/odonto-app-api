import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { api, bearer, createDentist, createPatient, createProcedure, loginAs, setupUser } from './helpers/factories.js';

async function setup() {
  const admin = await setupUser();
  const dentist = await createDentist(admin.clinic, { name: 'Dr. Paulo' });
  const patient = await createPatient(admin.clinic, { name: 'Ana Lima' });
  const cleaning = await createProcedure(admin.clinic, { name: 'Limpeza', price_cents: 15000 }); // sem condição de odontograma
  const filling = await createProcedure(admin.clinic, { name: 'Restauração', price_cents: 20000, odontogram_condition: 'restoration' });
  return { ...admin, dentist, patient, cleaning, filling };
}
const dentistHeaders = async (user) => bearer((await loginAs(user)).accessToken);

// orçamento aprovado com: [0] limpeza (sem dente), [1] restauração no 16 (faces D e O), [2] restauração sem dente
async function approvedBudget(c, dentistId = c.dentist.dentist.id) {
  const res = await api().post('/api/budgets').set(c.headers).send({
    patientId: c.patient.id, dentistId,
    items: [{ procedureId: c.cleaning.id }, { procedureId: c.filling.id, tooth: 16, faces: 'OD' }, { procedureId: c.filling.id }],
  });
  await api().post(`/api/budgets/${res.body.id}/status`).set(c.headers).send({ status: 'approved' });
  return res.body;
}
const perform = (headers, b, index, body) => api().post(`/api/budgets/${b.id}/items/${b.items[index].id}/perform`).set(headers).send(body);
const cancel = (headers, b, index) => api().post(`/api/budgets/${b.id}/items/${b.items[index].id}/cancel`).set(headers);

describe('POST /api/budgets/:id/items/:itemId/perform', () => {
  it('registra a execução (por padrão, pelo dentista do orçamento) e marca o dente no odontograma', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const res = await perform(c.headers, b, 1, {});
    expect(res.status).toBe(200);
    expect(res.body.items[1]).toMatchObject({ status: 'done', performedByDentistId: c.dentist.dentist.id });
    expect(res.body.items[1].performedAt).toBeTruthy();
    expect(res.body.status).toBe('approved'); // ainda há itens pendentes

    const records = await db('tooth_records').where({ patient_id: c.patient.id });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ tooth: 16, faces: 'DO', condition: 'restoration', source_item_id: b.items[1].id, recorded_by: c.user.id });
  });

  it('o dia da marcação no odontograma segue o horário de Brasília (02:00 UTC ainda é o dia anterior)', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    await perform(c.headers, b, 1, { performedAt: '2026-11-03T02:00:00.000Z' });
    expect((await db('tooth_records').first()).recorded_on).toBe('2026-11-02');
  });

  it('sem dente ou sem condição no procedimento, não marca o odontograma', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    await perform(c.headers, b, 0, {}); // limpeza: procedimento sem condição
    await perform(c.headers, b, 2, {}); // restauração sem dente
    expect(await db('tooth_records')).toHaveLength(0);
  });

  it('aceita requisição sem corpo e data de execução informada', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const bare = await api().post(`/api/budgets/${b.id}/items/${b.items[0].id}/perform`).set(c.headers);
    expect(bare.status).toBe(200);
    const dated = await perform(c.headers, b, 1, { performedAt: '2026-11-03T10:00:00-03:00' });
    expect(dated.body.items[1].performedAt).toBe('2026-11-03T13:00:00.000Z');
  });

  it('o administrador pode indicar quem executou; o dentista executa como ele mesmo', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic, { name: 'Dra. Bia' });
    const b = await approvedBudget(c);

    const byOther = await perform(c.headers, b, 0, { dentistId: other.dentist.id });
    expect(byOther.body.items[0].performedByDentistId).toBe(other.dentist.id);

    const own = await dentistHeaders(c.dentist.user);
    const mine = await perform(own, b, 1, {});
    expect(mine.body.items[1].performedByDentistId).toBe(c.dentist.dentist.id);
    const withOwnId = await perform(own, b, 2, { dentistId: c.dentist.dentist.id });
    expect(withOwnId.status).toBe(200);
  });

  it('dentista não registra execução em nome de outro (403) nem em orçamento alheio (404)', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic);
    const mine = await approvedBudget(c);
    const theirs = await approvedBudget(c, other.dentist.id);
    const own = await dentistHeaders(c.dentist.user);
    expect((await perform(own, mine, 0, { dentistId: other.dentist.id })).status).toBe(403);
    expect((await perform(own, theirs, 0, {})).status).toBe(404);
  });

  it('executor desativado: 422; inexistente ou de outra clínica: 404', async () => {
    const c = await setup();
    const off = await createDentist(c.clinic, { active: false });
    const foreign = await createDentist((await setup()).clinic);
    const b = await approvedBudget(c);
    expect((await perform(c.headers, b, 0, { dentistId: off.dentist.id })).status).toBe(422);
    expect((await perform(c.headers, b, 0, { dentistId: foreign.dentist.id })).status).toBe(404);
  });

  it('só em orçamento aprovado (409 BUDGET_NOT_APPROVED) e só uma vez por item (409 ITEM_NOT_PENDING)', async () => {
    const c = await setup();
    const open = (await api().post('/api/budgets').set(c.headers).send({
      patientId: c.patient.id, dentistId: c.dentist.dentist.id, items: [{ procedureId: c.cleaning.id }],
    })).body;
    const early = await perform(c.headers, open, 0, {});
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('BUDGET_NOT_APPROVED');

    const b = await approvedBudget(c);
    expect((await perform(c.headers, b, 0, {})).status).toBe(200);
    const again = await perform(c.headers, b, 0, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ITEM_NOT_PENDING');
  });

  it('secretária não executa (403); item inexistente ou de outro orçamento: 404; corpo inválido: 400', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const other = await approvedBudget(c);
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    expect((await perform(secretary.headers, b, 0, {})).status).toBe(403);
    expect((await api().post(`/api/budgets/${b.id}/items/${other.items[0].id}/perform`).set(c.headers).send({})).status).toBe(404);
    expect((await perform(c.headers, b, 0, { performedAt: 'ontem' })).status).toBe(400);
    expect((await perform(c.headers, b, 0, { dentistId: 'abc' })).status).toBe(400);
  });

  it('com todos os itens finalizados (executados ou cancelados), o orçamento vira "completed"', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    await perform(c.headers, b, 0, {});
    await cancel(c.headers, b, 2);
    const last = await perform(c.headers, b, 1, {});
    expect(last.body.status).toBe('completed');
    expect((await api().get(`/api/budgets?status=completed`).set(c.headers)).body.total).toBe(1);
  });
});

describe('POST /api/budgets/:id/items/:itemId/cancel', () => {
  it('o paciente desistiu: o item sai do subtotal; o total nunca fica negativo', async () => {
    const c = await setup();
    const res = await api().post('/api/budgets').set(c.headers).send({
      patientId: c.patient.id, dentistId: c.dentist.dentist.id, discountCents: 30000,
      items: [{ procedureId: c.cleaning.id }, { procedureId: c.filling.id, tooth: 16 }],
    });
    const b = res.body;
    await api().post(`/api/budgets/${b.id}/status`).set(c.headers).send({ status: 'approved' });

    const canceled = await cancel(c.headers, b, 1);
    expect(canceled.status).toBe(200);
    expect(canceled.body.items[1].status).toBe('canceled');
    expect(canceled.body).toMatchObject({ itemsCount: 1, subtotalCents: 15000, discountCents: 30000, totalCents: 0, status: 'approved' });
    expect(await db('tooth_records')).toHaveLength(0);
  });

  it('cancelar o último item pendente conclui o orçamento', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    await perform(c.headers, b, 0, {});
    await perform(c.headers, b, 1, {});
    expect((await cancel(c.headers, b, 2)).body.status).toBe('completed');
  });

  it('só com orçamento aprovado (409) e só item pendente (409); secretária 403; item inexistente 404', async () => {
    const c = await setup();
    const open = (await api().post('/api/budgets').set(c.headers).send({
      patientId: c.patient.id, dentistId: c.dentist.dentist.id, items: [{ procedureId: c.cleaning.id }],
    })).body;
    expect((await cancel(c.headers, open, 0)).body.code).toBe('BUDGET_NOT_APPROVED');

    const b = await approvedBudget(c);
    await perform(c.headers, b, 0, {});
    expect((await cancel(c.headers, b, 0)).body.code).toBe('ITEM_NOT_PENDING');
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    expect((await cancel(secretary.headers, b, 1)).status).toBe(403);
    expect((await api().post(`/api/budgets/${b.id}/items/00000000-0000-4000-8000-000000000000/cancel`).set(c.headers)).status).toBe(404);
  });
});
