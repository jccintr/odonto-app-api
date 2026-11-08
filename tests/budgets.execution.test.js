import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { api, createDentist, createPatient, createProcedure, setupUser } from './helpers/factories.js';
import { execute } from './helpers/execute.js';

async function setup() {
  const admin = await setupUser();
  const dentist = await createDentist(admin.clinic, { name: 'Dr. Paulo' });
  const patient = await createPatient(admin.clinic, { name: 'Ana Lima' });
  const cleaning = await createProcedure(admin.clinic, { name: 'Limpeza', price_cents: 15000 }); // sem condição de odontograma
  const filling = await createProcedure(admin.clinic, { name: 'Restauração', price_cents: 20000, odontogram_condition: 'restoration' });
  return { ...admin, dentist, patient, cleaning, filling };
}

// orçamento aprovado com: [0] limpeza (sem dente), [1] restauração no 16 (faces D e O), [2] restauração sem dente
async function approvedBudget(c, dentistId = c.dentist.dentist.id) {
  const res = await api().post('/api/budgets').set(c.headers).send({
    patientId: c.patient.id, dentistId,
    items: [{ procedureId: c.cleaning.id }, { procedureId: c.filling.id, tooth: 16, faces: 'OD' }, { procedureId: c.filling.id }],
  });
  await api().post(`/api/budgets/${res.body.id}/status`).set(c.headers).send({ status: 'approved' });
  return res.body;
}
// a execução só existe dentro de um atendimento (iniciar e concluir); devolve a resposta do atendimento
const perform = (c, b, indexes, dentist = c.dentist) => execute({ admin: c.headers, dentist, budget: b, indexes: [].concat(indexes) });
const budgetOf = async (c, b) => (await api().get(`/api/budgets/${b.id}`).set(c.headers)).body;
const cancel = (headers, b, index) => api().post(`/api/budgets/${b.id}/items/${b.items[index].id}/cancel`).set(headers);

describe('execução dos itens do orçamento (dentro do atendimento)', () => {
  it('o dentista executa o item: registra quem fez, marca o dente no odontograma e o orçamento segue aprovado enquanto houver itens pendentes', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    expect((await perform(c, b, 1)).status).toBe(200);
    const after = await budgetOf(c, b);
    expect(after.items[1]).toMatchObject({ status: 'done', performedByDentistId: c.dentist.dentist.id });
    expect(after.items[1].performedAt).toBeTruthy();
    expect(after.status).toBe('approved');

    const records = await db('tooth_records').where({ patient_id: c.patient.id });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ tooth: 16, faces: 'DO', condition: 'restoration', source_item_id: b.items[1].id, recorded_by: c.dentist.user.id });
  });

  it('sem dente ou sem condição no procedimento, não marca o odontograma', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    expect((await perform(c, b, [0, 2])).status).toBe(200); // limpeza (sem condição) e restauração sem dente (boca toda)
    expect(await db('tooth_records')).toHaveLength(0);
  });

  it('outro dentista da clínica executa o que o paciente aprovou, mesmo no orçamento de um colega', async () => {
    const c = await setup();
    const other = await createDentist(c.clinic, { name: 'Dra. Bia' });
    const b = await approvedBudget(c);
    expect((await perform(c, b, 0, other)).status).toBe(200);
    expect((await budgetOf(c, b)).items[0].performedByDentistId).toBe(other.dentist.id);
  });

  it('só em orçamento aprovado (409 BUDGET_NOT_APPROVED) e só uma vez por item (409 ITEM_NOT_PENDING)', async () => {
    const c = await setup();
    const open = (await api().post('/api/budgets').set(c.headers).send({
      patientId: c.patient.id, dentistId: c.dentist.dentist.id, items: [{ procedureId: c.cleaning.id }],
    })).body;
    const early = await perform(c, open, 0);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('BUDGET_NOT_APPROVED');

    const b = await approvedBudget(c);
    expect((await perform(c, b, 0)).status).toBe(200);
    const again = await perform(c, b, 0);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ITEM_NOT_PENDING');
  });

  it('com todos os itens finalizados (executados ou cancelados), o orçamento vira "completed"', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    await perform(c, b, 0);
    await cancel(c.headers, b, 2);
    expect((await budgetOf(c, b)).status).toBe('approved');
    await perform(c, b, 1);
    expect((await budgetOf(c, b)).status).toBe('completed');
    expect((await api().get('/api/budgets?status=completed').set(c.headers)).body.total).toBe(1);
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
    await perform(c, b, [0, 1]);
    expect((await cancel(c.headers, b, 2)).body.status).toBe('completed');
  });

  it('só com orçamento aprovado (409) e só item pendente (409); secretária 403; item inexistente 404', async () => {
    const c = await setup();
    const open = (await api().post('/api/budgets').set(c.headers).send({
      patientId: c.patient.id, dentistId: c.dentist.dentist.id, items: [{ procedureId: c.cleaning.id }],
    })).body;
    expect((await cancel(c.headers, open, 0)).body.code).toBe('BUDGET_NOT_APPROVED');

    const b = await approvedBudget(c);
    await perform(c, b, 0);
    expect((await cancel(c.headers, b, 0)).body.code).toBe('ITEM_NOT_PENDING');
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    expect((await cancel(secretary.headers, b, 1)).status).toBe(403);
    expect((await api().post(`/api/budgets/${b.id}/items/00000000-0000-4000-8000-000000000000/cancel`).set(c.headers)).status).toBe(404);
  });
});
