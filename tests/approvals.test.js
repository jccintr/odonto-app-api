import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { api, createDentist, createPatient, createProcedure, setupUser } from './helpers/factories.js';
import { execute, headersOf } from './helpers/execute.js';

async function setup() {
  const admin = await setupUser();
  const dentist = await createDentist(admin.clinic, { name: 'Dr. Paulo' });
  const other = await createDentist(admin.clinic, { name: 'Dra. Bia' });
  const patient = await createPatient(admin.clinic, { name: 'Ana Lima' });
  const filling = await createProcedure(admin.clinic, { name: 'Restauração', price_cents: 20000 });
  const cleaning = await createProcedure(admin.clinic, { name: 'Limpeza', price_cents: 10000 });
  return { ...admin, dentist, other, patient, filling, cleaning };
}

// orçamento com restauração (20000), limpeza (10000) e outra restauração (20000), tudo ainda só proposto
async function proposal(c, { dentist = c.dentist } = {}) {
  const res = await api().post('/api/budgets').set(c.headers).send({
    patientId: c.patient.id, dentistId: dentist.dentist.id,
    items: [{ procedureId: c.filling.id }, { procedureId: c.cleaning.id }, { procedureId: c.filling.id }],
  });
  return res.body;
}
const approve = (c, budget, body) => api().post(`/api/budgets/${budget.id}/approvals`).set(c.headers).send(body);
const get = async (c, budget) => (await api().get(`/api/budgets/${budget.id}`).set(c.headers)).body;
const plan = (c, budget, body) => api().post(`/api/budgets/${budget.id}/payment-plan`).set(c.headers).send(body);
const payments = async (c, budget) => (await api().get(`/api/budgets/${budget.id}/payments`).set(c.headers)).body;
const missing = '00000000-0000-4000-8000-000000000000';

describe('POST /api/budgets/:id/approvals', () => {
  it('aprova só parte dos itens, com desconto próprio; o resto continua proposto', async () => {
    const c = await setup();
    const b = await proposal(c);
    const res = await approve(c, b, { itemIds: [b.items[0].id, b.items[1].id], discountCents: 5000, notes: 'Entrada combinada' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'approved', subtotalCents: 50000, discountCents: 5000, totalCents: 45000 });
    expect(res.body.approvedAt).not.toBeNull();
    expect(res.body.approvals).toEqual([expect.objectContaining({ itemsCount: 2, subtotalCents: 30000, discountCents: 5000, totalCents: 25000, notes: 'Entrada combinada' })]);
    const [first, second, third] = res.body.items;
    expect(first.approvalId).toBe(res.body.approvals[0].id);
    expect(second.approvalId).toBe(first.approvalId);
    expect(third.approvalId).toBeNull();
  });

  it('uma segunda rodada, depois, tem o próprio desconto e não mexe na anterior', async () => {
    const c = await setup();
    const b = await proposal(c);
    await approve(c, b, { itemIds: [b.items[0].id], discountCents: 2000 });
    const { approvals: [before], approvedAt } = await get(c, b);
    const res = await approve(c, b, { itemIds: [b.items[2].id], discountCents: 0 });
    expect(res.status).toBe(201);
    expect(res.body.approvals).toHaveLength(2);
    expect(res.body.approvals[0]).toEqual(before);
    expect(res.body.approvals[1]).toMatchObject({ itemsCount: 1, subtotalCents: 20000, discountCents: 0, totalCents: 20000 });
    expect(res.body.discountCents).toBe(2000); // soma dos descontos das rodadas
    expect(res.body.approvedAt).toBe(approvedAt); // a data da primeira aprovação não muda
  });

  it('o desconto não passa do valor dos itens escolhidos (422) e nada é criado', async () => {
    const c = await setup();
    const b = await proposal(c);
    expect((await approve(c, b, { itemIds: [b.items[1].id], discountCents: 10001 })).status).toBe(422);
    expect((await get(c, b)).approvals).toEqual([]);
    expect((await get(c, b)).status).toBe('open');
  });

  it('item já aprovado, finalizado ou de outro orçamento: erro claro', async () => {
    const c = await setup();
    const b = await proposal(c);
    const other = await proposal(c);
    await approve(c, b, { itemIds: [b.items[0].id] });
    expect((await approve(c, b, { itemIds: [b.items[0].id] })).body.code).toBe('ITEM_ALREADY_APPROVED');
    expect((await approve(c, b, { itemIds: [b.items[2].id, other.items[0].id] })).status).toBe(404);
    expect((await approve(c, b, { itemIds: [missing] })).status).toBe(404);
    await api().post(`/api/budgets/${b.id}/items/${b.items[1].id}/cancel`).set(c.headers);
    expect((await approve(c, b, { itemIds: [b.items[1].id] })).body.code).toBe('ITEM_NOT_PENDING');
    expect((await get(c, b)).approvals).toHaveLength(1);
  });

  it('orçamento recusado não recebe aprovação (409); outro id: 404; corpo inválido: 400', async () => {
    const c = await setup();
    const b = await proposal(c);
    expect((await approve(c, b, { itemIds: [] })).status).toBe(400);
    expect((await approve(c, b, { itemIds: [b.items[0].id, b.items[0].id] })).status).toBe(400);
    expect((await approve(c, b, { itemIds: ['x'] })).status).toBe(400);
    expect((await approve(c, b, { itemIds: [b.items[0].id], discountCents: -1 })).status).toBe(400);
    expect((await approve(c, { id: missing }, { itemIds: [b.items[0].id] })).status).toBe(404);
    await api().post(`/api/budgets/${b.id}/status`).set(c.headers).send({ status: 'rejected' });
    expect((await approve(c, b, { itemIds: [b.items[0].id] })).body.code).toBe('BUDGET_NOT_OPEN');
  });

  it('a aprovação é da recepção: secretária e administrador registram; o dentista não (403)', async () => {
    const c = await setup();
    const b = await proposal(c);
    const secretary = await setupUser({ role: 'secretary', clinic: c.clinic });
    expect((await api().post(`/api/budgets/${b.id}/approvals`).set(secretary.headers).send({ itemIds: [b.items[0].id] })).status).toBe(201);
    expect((await api().post(`/api/budgets/${b.id}/approvals`).set(c.headers).send({ itemIds: [b.items[1].id] })).status).toBe(201);
    const ownHeaders = await headersOf(c.dentist.user);
    expect((await api().post(`/api/budgets/${b.id}/approvals`).set(ownHeaders).send({ itemIds: [b.items[2].id] })).status).toBe(403);
  });

  it('em tratamento ainda dá para ajustar o dente do que está só proposto, sem mexer no aprovado', async () => {
    const c = await setup();
    const b = await proposal(c);
    await approve(c, b, { itemIds: [b.items[0].id], discountCents: 1000 });
    const res = await api().patch(`/api/budgets/${b.id}/items/${b.items[1].id}`).set(c.headers).send({ tooth: 17 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ discountCents: 1000 });
    expect(res.body.items[1].tooth).toBe(17);
    expect(res.body.approvals[0]).toMatchObject({ subtotalCents: 20000, totalCents: 19000 });
  });

  it('registra a aprovação na auditoria', async () => {
    const c = await setup();
    const b = await proposal(c);
    const res = await approve(c, b, { itemIds: [b.items[0].id], discountCents: 100 });
    const rows = await db('audit_log').where({ entity: 'budget_approval', entity_id: res.body.approvals[0].id });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('create');
  });

  it('aprovar o orçamento inteiro pelo status continua valendo: uma rodada com todos os itens e o desconto do orçamento', async () => {
    const c = await setup();
    const b = (await api().post('/api/budgets').set(c.headers).send({ patientId: c.patient.id, dentistId: c.dentist.dentist.id, discountCents: 3000, items: [{ procedureId: c.filling.id }, { procedureId: c.cleaning.id }] })).body;
    const res = await api().post(`/api/budgets/${b.id}/status`).set(c.headers).send({ status: 'approved' });
    expect(res.body.approvals).toEqual([expect.objectContaining({ itemsCount: 2, subtotalCents: 30000, discountCents: 3000, totalCents: 27000 })]);
    expect(res.body.items.every((item) => item.approvalId === res.body.approvals[0].id)).toBe(true);
  });
});

describe('pagamentos por rodada', () => {
  async function twoRounds() {
    const c = await setup();
    const b = await proposal(c);
    const r1 = (await approve(c, b, { itemIds: [b.items[0].id, b.items[1].id], discountCents: 5000 })).body.approvals[0];
    const r2 = (await approve(c, b, { itemIds: [b.items[2].id], discountCents: 0 })).body.approvals[1];
    return { c, b, r1, r2 };
  }

  it('cada rodada tem as próprias parcelas, sem mexer nas anteriores', async () => {
    const { c, b, r1, r2 } = await twoRounds();
    const first = await plan(c, b, { installments: 3, firstDueDate: '2099-01-10', approvalId: r1.id });
    expect(first.status).toBe(201);
    expect(first.body.map((p) => p.amountCents)).toEqual([8334, 8333, 8333]);
    expect(first.body.every((p) => p.approvalId === r1.id)).toBe(true);

    const second = await plan(c, b, { installments: 2, firstDueDate: '2099-06-10', approvalId: r2.id });
    expect(second.body.map((p) => p.amountCents)).toEqual([10000, 10000]);

    const list = await payments(c, b);
    expect(list.summary).toMatchObject({ totalCents: 45000, scheduledCents: 45000, balanceCents: 0 });
    expect(list.approvals).toEqual([
      { approvalId: r1.id, totalCents: 25000, scheduledCents: 25000, paidCents: 0, balanceCents: 0 },
      { approvalId: r2.id, totalCents: 20000, scheduledCents: 20000, paidCents: 0, balanceCents: 0 },
    ]);
    expect(list.data.filter((p) => p.approvalId === r1.id)).toHaveLength(3); // a primeira rodada seguiu intacta
  });

  it('com mais de uma rodada é preciso dizer qual (422); rodada de outro orçamento: 404', async () => {
    const { c, b, r1 } = await twoRounds();
    const body = { amountCents: 1000, dueDate: '2099-01-10' };
    const res = await api().post(`/api/budgets/${b.id}/payments`).set(c.headers).send(body);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('APPROVAL_REQUIRED');
    expect((await plan(c, b, { installments: 2, firstDueDate: '2099-01-10' })).body.code).toBe('APPROVAL_REQUIRED');
    const foreign = await proposal(c);
    const foreignRound = (await approve(c, foreign, { itemIds: [foreign.items[0].id] })).body.approvals[0];
    expect((await api().post(`/api/budgets/${b.id}/payments`).set(c.headers).send({ ...body, approvalId: foreignRound.id })).status).toBe(404);
    expect((await api().post(`/api/budgets/${b.id}/payments`).set(c.headers).send({ ...body, approvalId: r1.id })).status).toBe(201);
  });

  it('o saldo é da rodada: não dá para lançar na rodada A o que sobra na B', async () => {
    const { c, b, r1, r2 } = await twoRounds();
    const over = await api().post(`/api/budgets/${b.id}/payments`).set(c.headers).send({ amountCents: 25001, dueDate: '2099-01-10', approvalId: r1.id });
    expect(over.status).toBe(422);
    expect(over.body).toMatchObject({ code: 'EXCEEDS_BALANCE', balanceCents: 25000 });
    const ok = await api().post(`/api/budgets/${b.id}/payments`).set(c.headers).send({ amountCents: 20000, method: 'pix', paidAt: '2026-11-03T12:00:00.000Z', approvalId: r2.id });
    expect(ok.status).toBe(201);
    expect((await payments(c, b)).approvals[1]).toMatchObject({ paidCents: 20000, balanceCents: 0 });
    const patchOver = await plan(c, b, { installments: 2, firstDueDate: '2099-01-10', approvalId: r1.id, amountCents: 30000 });
    expect(patchOver.body.code).toBe('EXCEEDS_BALANCE');
  });

  it('alterar o valor de uma parcela respeita o saldo da rodada dela', async () => {
    const { c, b, r1 } = await twoRounds();
    const parcels = (await plan(c, b, { installments: 2, firstDueDate: '2099-01-10', approvalId: r1.id })).body;
    const tooMuch = await api().patch(`/api/payments/${parcels[0].id}`).set(c.headers).send({ amountCents: 20000 });
    expect(tooMuch.status).toBe(422);
    expect((await api().patch(`/api/payments/${parcels[0].id}`).set(c.headers).send({ amountCents: 12500 })).status).toBe(200);
  });

  it('com uma rodada só, não precisa informar qual', async () => {
    const c = await setup();
    const b = await proposal(c);
    const round = (await approve(c, b, { itemIds: [b.items[0].id] })).body.approvals[0];
    const res = await plan(c, b, { installments: 2, firstDueDate: '2099-01-10' });
    expect(res.status).toBe(201);
    expect(res.body[0].approvalId).toBe(round.id);
  });
});

describe('execução e repasse por rodada', () => {
  it('só executa o que o paciente aprovou (409 ITEM_NOT_APPROVED)', async () => {
    const c = await setup();
    const b = await proposal(c);
    await approve(c, b, { itemIds: [b.items[0].id] });
    const res = await execute({ admin: c.headers, dentist: c.dentist, budget: b, indexes: [2] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ITEM_NOT_APPROVED');
    expect((await get(c, b)).items[2].status).toBe('pending');
  });

  it('o repasse segue o desconto da rodada do item, não o das outras', async () => {
    const c = await setup();
    const b = await proposal(c);
    await approve(c, b, { itemIds: [b.items[0].id, b.items[1].id], discountCents: 15000 }); // 20000 + 10000 com 15000 de desconto
    await approve(c, b, { itemIds: [b.items[2].id], discountCents: 0 });
    expect((await execute({ admin: c.headers, dentist: c.other, budget: b, indexes: [0, 2] })).status).toBe(200);
    const entries = await db('payout_entries').whereIn('item_id', [b.items[0].id, b.items[2].id]);
    const gross = (id) => entries.find((e) => e.item_id === id).gross_cents;
    expect(gross(b.items[0].id)).toBe(10000); // 20000 - 15000 * 20000/30000
    expect(gross(b.items[2].id)).toBe(20000); // sem desconto na rodada 2
  });

  it('o orçamento só conclui quando não resta item pendente, aprovado ou proposto', async () => {
    const c = await setup();
    const b = await proposal(c);
    await approve(c, b, { itemIds: [b.items[0].id] });
    await execute({ admin: c.headers, dentist: c.dentist, budget: b, indexes: [0] });
    expect((await get(c, b)).status).toBe('approved'); // sobram dois propostos
    // propostos podem ser removidos ou cancelados pelo paciente
    expect((await api().delete(`/api/budgets/${b.id}/items/${b.items[1].id}`).set(c.headers)).status).toBe(200);
    expect((await get(c, b)).status).toBe('approved');
    const done = await api().post(`/api/budgets/${b.id}/items/${b.items[2].id}/cancel`).set(c.headers);
    expect(done.body.status).toBe('completed');
  });

  it('remover o único item proposto de um orçamento em aberto não o conclui', async () => {
    const c = await setup();
    const b = (await api().post('/api/budgets').set(c.headers).send({ patientId: c.patient.id, dentistId: c.dentist.dentist.id, items: [{ procedureId: c.filling.id }] })).body;
    const res = await api().delete(`/api/budgets/${b.id}/items/${b.items[0].id}`).set(c.headers);
    expect(res.body).toMatchObject({ status: 'open', itemsCount: 0 });
  });
});

describe('GET /api/patients/:id/treatment-items', () => {
  it('lista o que está aprovado e a realizar, de todos os dentistas, sem valores', async () => {
    const c = await setup();
    const mine = await proposal(c);
    const theirs = await proposal(c, { dentist: c.other });
    await approve(c, mine, { itemIds: [mine.items[0].id, mine.items[1].id] });
    await approve(c, theirs, { itemIds: [theirs.items[2].id] });
    await execute({ admin: c.headers, dentist: c.dentist, budget: mine, indexes: [1] }); // executado sai da lista

    // o dentista Bia enxerga também o que está no orçamento do Paulo
    const res = await api().get(`/api/patients/${c.patient.id}/treatment-items`).set(await headersOf(c.other.user));
    expect(res.status).toBe(200);
    expect(res.body.data.map((i) => i.itemId)).toEqual([mine.items[0].id, theirs.items[2].id]);
    expect(res.body.data[0]).toMatchObject({ budgetId: mine.id, procedure: { name: 'Restauração' }, dentist: { name: 'Dr. Paulo' }, tooth: null, faces: null });
    expect(res.body.data[0]).not.toHaveProperty('priceCents');
    expect(res.body.data.map((i) => i.itemId)).not.toContain(mine.items[2].id); // proposto
  });

  it('paciente sem aprovação: lista vazia; outro id ou outra clínica: 404', async () => {
    const c = await setup();
    await proposal(c);
    expect((await api().get(`/api/patients/${c.patient.id}/treatment-items`).set(c.headers)).body).toEqual({ data: [] });
    expect((await api().get(`/api/patients/${missing}/treatment-items`).set(c.headers)).status).toBe(404);
    const foreign = await setup();
    expect((await api().get(`/api/patients/${foreign.patient.id}/treatment-items`).set(c.headers)).status).toBe(404);
  });
});
