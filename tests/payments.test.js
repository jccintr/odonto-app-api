import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { api, createClinic, createDentist, createPatient, createProcedure, setupUser } from './helpers/factories.js';

async function setup() {
  const admin = await setupUser();
  const secretary = await setupUser({ role: 'secretary', clinic: admin.clinic });
  const dentist = await createDentist(admin.clinic, { name: 'Dr. Paulo' });
  const patient = await createPatient(admin.clinic, { name: 'Ana Lima' });
  const procedure = await createProcedure(admin.clinic, { name: 'Implante', price_cents: 50000 });
  return { ...admin, secretary, dentist, patient, procedure };
}

// orçamento aprovado de 100.000 centavos (2 itens de 50.000), menos o desconto
async function approvedBudget(c, { discountCents = 0 } = {}) {
  const res = await api().post('/api/budgets').set(c.headers).send({
    patientId: c.patient.id, dentistId: c.dentist.dentist.id, discountCents,
    items: [{ procedureId: c.procedure.id, tooth: 16 }, { procedureId: c.procedure.id, tooth: 26 }],
  });
  await api().post(`/api/budgets/${res.body.id}/status`).set(c.headers).send({ status: 'approved' });
  return res.body;
}
const receive = (headers, budget, body) => api().post(`/api/budgets/${budget.id}/payments`).set(headers).send(body);
const plan = (headers, budget, body) => api().post(`/api/budgets/${budget.id}/payment-plan`).set(headers).send(body);
const audit = (id) => db('audit_log').where({ entity: 'payment', entity_id: id }).orderBy('created_at');

describe('POST /api/budgets/:id/payments', () => {
  it('lança uma parcela a receber (pendente) e audita', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const res = await receive(c.headers, b, { amountCents: 30000, dueDate: '2099-01-10', notes: 'Entrada' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      budgetId: b.id, patient: { id: c.patient.id, name: 'Ana Lima' }, amountCents: 30000, dueDate: '2099-01-10', status: 'pending',
      overdue: false, method: null, paidAt: null, installment: null, installmentsTotal: null, canceledReason: null, notes: 'Entrada',
    });
    expect((await audit(res.body.id)).map((a) => a.action)).toEqual(['create']);
  });

  it('lança um recebimento na hora (já pago): o vencimento padrão é o dia do pagamento, no horário de Brasília', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const res = await receive(c.headers, b, { amountCents: 20000, method: 'pix', paidAt: '2026-11-03T02:00:00.000Z' });
    expect(res.body).toMatchObject({ status: 'paid', method: 'pix', paidAt: '2026-11-03T02:00:00.000Z', dueDate: '2026-11-02', overdue: false });
    const row = await db('payments').where({ id: res.body.id }).first();
    expect(row.received_by).toBe(c.user.id);

    const withDue = await receive(c.headers, b, { amountCents: 100, method: 'cash', paidAt: '2026-11-03T12:00:00.000Z', dueDate: '2026-10-30' });
    expect(withDue.body.dueDate).toBe('2026-10-30');
  });

  it('parcela vencida e ainda pendente aparece como "overdue"', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const res = await receive(c.headers, b, { amountCents: 100, dueDate: '2020-01-01' });
    expect(res.body).toMatchObject({ status: 'pending', overdue: true });
  });

  it('só em orçamento aprovado ou concluído', async () => {
    const c = await setup();
    const open = (await api().post('/api/budgets').set(c.headers).send({
      patientId: c.patient.id, dentistId: c.dentist.dentist.id, items: [{ procedureId: c.procedure.id }],
    })).body;
    const early = await receive(c.headers, open, { amountCents: 100, dueDate: '2099-01-01' });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('BUDGET_NOT_APPROVED');

    await api().post(`/api/budgets/${open.id}/status`).set(c.headers).send({ status: 'rejected' });
    expect((await receive(c.headers, open, { amountCents: 100, dueDate: '2099-01-01' })).status).toBe(409);

    const b = await approvedBudget(c);
    await db('budgets').where({ id: b.id }).update({ status: 'completed' });
    expect((await receive(c.headers, b, { amountCents: 100, dueDate: '2099-01-01' })).status).toBe(201);
  });

  it('não passa do saldo do orçamento (já considerando o desconto); cancelar devolve o saldo', async () => {
    const c = await setup();
    const b = await approvedBudget(c, { discountCents: 10000 }); // total 90.000
    const first = await receive(c.headers, b, { amountCents: 60000, dueDate: '2099-01-10' });
    const over = await receive(c.headers, b, { amountCents: 30001, dueDate: '2099-02-10' });
    expect(over.status).toBe(422);
    expect(over.body).toMatchObject({ code: 'EXCEEDS_BALANCE', balanceCents: 30000 });
    expect((await receive(c.headers, b, { amountCents: 30000, dueDate: '2099-02-10' })).status).toBe(201);

    expect((await receive(c.headers, b, { amountCents: 1, dueDate: '2099-03-10' })).status).toBe(422);
    await api().post(`/api/payments/${first.body.id}/cancel`).set(c.headers).send({});
    expect((await receive(c.headers, b, { amountCents: 60000, dueDate: '2099-03-10' })).status).toBe(201);
  });

  it('404 para orçamento de outra clínica ou inexistente; 400 para id inválido', async () => {
    const c = await setup();
    const foreign = await setup();
    const foreignBudget = await approvedBudget(foreign);
    const body = { amountCents: 100, dueDate: '2099-01-01' };
    expect((await receive(c.headers, foreignBudget, body)).status).toBe(404);
    expect((await receive(c.headers, { id: '00000000-0000-4000-8000-000000000000' }, body)).status).toBe(404);
    expect((await receive(c.headers, { id: 'abc' }, body)).status).toBe(400);
  });

  it('administração e secretária lançam; dentista não (403); sem login (401)', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const body = { amountCents: 100, dueDate: '2099-01-01' };
    expect((await receive(c.secretary.headers, b, body)).status).toBe(201);
    const dentist = await setupUser({ role: 'dentist', clinic: c.clinic });
    expect((await receive(dentist.headers, b, body)).status).toBe(403);
    expect((await api().post(`/api/budgets/${b.id}/payments`).send(body)).status).toBe(401);
  });

  it('valida o corpo (400)', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const bad = [
      {}, { dueDate: '2099-01-01' }, { amountCents: 0, dueDate: '2099-01-01' }, { amountCents: -5, dueDate: '2099-01-01' },
      { amountCents: 10.5, dueDate: '2099-01-01' }, { amountCents: 200_000_000, dueDate: '2099-01-01' }, { amountCents: 100 },
      { amountCents: 100, dueDate: '2099-01-01', method: 'pix' }, { amountCents: 100, paidAt: '2026-11-03T10:00:00.000Z' },
      { amountCents: 100, method: 'fiado', paidAt: '2026-11-03T10:00:00.000Z' }, { amountCents: 100, dueDate: '01/01/2099' },
      { amountCents: 100, method: 'pix', paidAt: 'ontem' }, { amountCents: 100, dueDate: '2099-01-01', notes: 'x'.repeat(501) },
    ];
    for (const body of bad) expect((await receive(c.headers, b, body)).status, JSON.stringify(body)).toBe(400);
  });
});

describe('POST /api/budgets/:id/payment-plan', () => {
  it('divide o saldo em parcelas mensais (centavos que sobram nas primeiras; dia 31 vira o último dia do mês) e audita cada uma', async () => {
    const c = await setup();
    const b = await approvedBudget(c, { discountCents: 1 }); // total 99.999
    const res = await plan(c.headers, b, { installments: 3, firstDueDate: '2099-01-31' });
    expect(res.status).toBe(201);
    expect(res.body.map((p) => [p.installment, p.installmentsTotal, p.amountCents, p.dueDate, p.status])).toEqual([
      [1, 3, 33333, '2099-01-31', 'pending'], [2, 3, 33333, '2099-02-28', 'pending'], [3, 3, 33333, '2099-03-31', 'pending'],
    ]);
    expect(await db('audit_log').where({ entity: 'payment', action: 'create' })).toHaveLength(3);

    const b2 = await approvedBudget(c); // 100.000 / 3
    const r2 = await plan(c.headers, b2, { installments: 3, firstDueDate: '2099-01-10' });
    expect(r2.body.map((p) => p.amountCents)).toEqual([33334, 33333, 33333]);
  });

  it('com valor informado, só parte do saldo vira parcela; o resto pode virar outro plano', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const first = await plan(c.headers, b, { installments: 2, firstDueDate: '2099-01-10', amountCents: 40000 });
    expect(first.body.map((p) => p.amountCents)).toEqual([20000, 20000]);
    const rest = await plan(c.headers, b, { installments: 1, firstDueDate: '2099-03-10' });
    expect(rest.body[0]).toMatchObject({ amountCents: 60000, installment: 1, installmentsTotal: 1 });
  });

  it('valor acima do saldo: 422 EXCEEDS_BALANCE; sem saldo: 422 NO_BALANCE; valor menor que o nº de parcelas: 422', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const over = await plan(c.headers, b, { installments: 2, firstDueDate: '2099-01-10', amountCents: 100001 });
    expect(over.body).toMatchObject({ code: 'EXCEEDS_BALANCE', balanceCents: 100000 });
    expect((await plan(c.headers, b, { installments: 3, firstDueDate: '2099-01-10', amountCents: 2 })).status).toBe(422);

    await plan(c.headers, b, { installments: 1, firstDueDate: '2099-01-10' });
    const none = await plan(c.headers, b, { installments: 1, firstDueDate: '2099-02-10' });
    expect(none.status).toBe(422);
    expect(none.body.code).toBe('NO_BALANCE');
  });

  it('só com orçamento aprovado (409); secretária gera; dentista não (403); 404 e validações (400)', async () => {
    const c = await setup();
    const open = (await api().post('/api/budgets').set(c.headers).send({
      patientId: c.patient.id, dentistId: c.dentist.dentist.id, items: [{ procedureId: c.procedure.id }],
    })).body;
    expect((await plan(c.headers, open, { installments: 1, firstDueDate: '2099-01-10' })).status).toBe(409);

    const b = await approvedBudget(c);
    expect((await plan(c.secretary.headers, b, { installments: 2, firstDueDate: '2099-01-10' })).status).toBe(201);
    const dentist = await setupUser({ role: 'dentist', clinic: c.clinic });
    expect((await plan(dentist.headers, b, { installments: 1, firstDueDate: '2099-01-10' })).status).toBe(403);
    expect((await plan(c.headers, { id: '00000000-0000-4000-8000-000000000000' }, { installments: 1, firstDueDate: '2099-01-10' })).status).toBe(404);
    for (const bad of [{}, { installments: 0, firstDueDate: '2099-01-10' }, { installments: 49, firstDueDate: '2099-01-10' },
      { installments: 1.5, firstDueDate: '2099-01-10' }, { installments: 2, firstDueDate: 'amanhã' }, { installments: 2, firstDueDate: '2099-01-10', amountCents: 0 }]) {
      expect((await plan(c.headers, b, bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('GET /api/budgets/:id/payments', () => {
  it('lista por vencimento com o resumo financeiro (cancelados não contam)', async () => {
    const c = await setup();
    const b = await approvedBudget(c); // total 100.000
    const late = await receive(c.headers, b, { amountCents: 10000, dueDate: '2020-01-01' }); // vencida
    await receive(c.headers, b, { amountCents: 20000, dueDate: '2099-01-10' });
    await receive(c.headers, b, { amountCents: 30000, method: 'pix', paidAt: '2026-11-03T12:00:00.000Z' });
    const dropped = await receive(c.headers, b, { amountCents: 5000, dueDate: '2099-02-10' });
    await api().post(`/api/payments/${dropped.body.id}/cancel`).set(c.headers).send({});

    const res = await api().get(`/api/budgets/${b.id}/payments`).set(c.headers);
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ totalCents: 100000, scheduledCents: 60000, paidCents: 30000, pendingCents: 30000, overdueCents: 10000, balanceCents: 40000 });
    expect(res.body.data.map((p) => p.dueDate)).toEqual(['2020-01-01', '2026-11-03', '2099-01-10', '2099-02-10']);
    expect(res.body.data[0].id).toBe(late.body.id);
  });

  it('o saldo nunca fica negativo, mesmo que o total caia depois de um item cancelado', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    await plan(c.headers, b, { installments: 1, firstDueDate: '2099-01-10' }); // lança 100.000
    await api().post(`/api/budgets/${b.id}/items/${b.items[0].id}/cancel`).set(c.headers); // total cai para 50.000
    const res = await api().get(`/api/budgets/${b.id}/payments`).set(c.headers);
    expect(res.body.summary).toMatchObject({ totalCents: 50000, scheduledCents: 100000, balanceCents: 0 });
  });

  it('orçamento sem lançamentos: tudo zerado; 404 para outra clínica; dentista 403', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const res = await api().get(`/api/budgets/${b.id}/payments`).set(c.headers);
    expect(res.body).toEqual({ summary: { totalCents: 100000, scheduledCents: 0, paidCents: 0, pendingCents: 0, overdueCents: 0, balanceCents: 100000 }, data: [] });

    const foreign = await setup();
    expect((await api().get(`/api/budgets/${b.id}/payments`).set(foreign.headers)).status).toBe(404);
    const dentist = await setupUser({ role: 'dentist', clinic: c.clinic });
    expect((await api().get(`/api/budgets/${b.id}/payments`).set(dentist.headers)).status).toBe(403);
    expect((await api().get('/api/budgets/abc/payments').set(c.headers)).status).toBe(400);
  });
});
