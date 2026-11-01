import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { withTenant } from '../src/db/tenant.js';
import { api, createDentist, createPatient, createProcedure, setupUser } from './helpers/factories.js';

async function setup() {
  const admin = await setupUser();
  const secretary = await setupUser({ role: 'secretary', clinic: admin.clinic });
  const dentist = await createDentist(admin.clinic, { name: 'Dr. Paulo' });
  const patient = await createPatient(admin.clinic, { name: 'Ana Lima' });
  const procedure = await createProcedure(admin.clinic, { name: 'Implante', price_cents: 50000 });
  return { ...admin, secretary, dentist, patient, procedure };
}
async function approvedBudget(c, patient = c.patient) {
  const res = await api().post('/api/budgets').set(c.headers).send({
    patientId: patient.id, dentistId: c.dentist.dentist.id, items: [{ procedureId: c.procedure.id }, { procedureId: c.procedure.id }],
  });
  await api().post(`/api/budgets/${res.body.id}/status`).set(c.headers).send({ status: 'approved' });
  return res.body;
}
const receive = (c, budget, body) => api().post(`/api/budgets/${budget.id}/payments`).set(c.headers).send(body);
const pending = async (c, budget, amountCents = 10000, dueDate = '2099-01-10') => (await receive(c, budget, { amountCents, dueDate })).body;
const paid = async (c, budget, amountCents = 10000) => (await receive(c, budget, { amountCents, method: 'cash', paidAt: '2026-11-03T12:00:00.000Z' })).body;
const audit = (id) => db('audit_log').where({ entity: 'payment', entity_id: id }).orderBy('created_at');

describe('GET /api/payments (contas a receber)', () => {
  async function seed() {
    const c = await setup();
    const p2 = await createPatient(c.clinic, { name: 'Bruno Costa' });
    const b1 = await approvedBudget(c);
    const b2 = await approvedBudget(c, p2);
    const late = await pending(c, b1, 10000, '2020-01-01');
    const future = await pending(c, b1, 20000, '2099-06-10');
    const received = (await receive(c, b2, { amountCents: 30000, method: 'pix', paidAt: '2026-11-03T12:00:00.000Z' })).body;
    const dropped = await pending(c, b2, 5000, '2099-03-10');
    await api().post(`/api/payments/${dropped.id}/cancel`).set(c.headers).send({});
    const foreign = await setup();
    await pending(foreign, await approvedBudget(foreign));
    return { ...c, p2, b1, b2, late, future, received, dropped };
  }
  const ids = async (c, qs = '') => (await api().get(`/api/payments?${qs}`).set(c.headers)).body.data.map((p) => p.id);

  it('lista só a própria clínica, por vencimento, e a secretária também enxerga', async () => {
    const c = await seed();
    const res = await api().get('/api/payments').set(c.secretary.headers);
    expect(res.body).toMatchObject({ page: 1, perPage: 20, total: 4, totalPages: 1 });
    expect(res.body.data.map((p) => p.id)).toEqual([c.late.id, c.received.id, c.dropped.id, c.future.id]);
  });

  it('filtra por situação, forma, paciente, orçamento e período de vencimento', async () => {
    const c = await seed();
    expect(await ids(c, 'status=paid')).toEqual([c.received.id]);
    expect(await ids(c, 'status=canceled')).toEqual([c.dropped.id]);
    expect(await ids(c, 'method=pix')).toEqual([c.received.id]);
    expect(await ids(c, `patientId=${c.p2.id}`)).toEqual([c.received.id, c.dropped.id]);
    expect(await ids(c, `budgetId=${c.b1.id}`)).toEqual([c.late.id, c.future.id]);
    expect(await ids(c, 'dueFrom=2099-01-01')).toEqual([c.dropped.id, c.future.id]);
    expect(await ids(c, 'dueTo=2026-12-31')).toEqual([c.late.id, c.received.id]);
    expect(await ids(c, 'dueFrom=2099-04-01&dueTo=2099-12-31')).toEqual([c.future.id]);
  });

  it('inadimplência: overdue=true traz só pendentes vencidas; overdue=false, o resto', async () => {
    const c = await seed();
    expect(await ids(c, 'overdue=true')).toEqual([c.late.id]);
    expect(await ids(c, 'overdue=true&status=pending')).toEqual([c.late.id]);
    expect(await ids(c, 'overdue=false')).toEqual([c.received.id, c.dropped.id, c.future.id]);
  });

  it('pagina; valida a consulta (400); dentista não acessa (403); sem login (401)', async () => {
    const c = await seed();
    const page = await api().get('/api/payments?perPage=3&page=2').set(c.headers);
    expect(page.body).toMatchObject({ page: 2, perPage: 3, total: 4, totalPages: 2 });
    expect(page.body.data).toHaveLength(1);
    for (const qs of ['status=x', 'method=fiado', 'patientId=abc', 'budgetId=abc', 'dueFrom=ontem', 'overdue=talvez', 'perPage=101']) {
      expect((await api().get(`/api/payments?${qs}`).set(c.headers)).status, qs).toBe(400);
    }
    const dentist = await setupUser({ role: 'dentist', clinic: c.clinic });
    expect((await api().get('/api/payments').set(dentist.headers)).status).toBe(403);
    expect((await api().get('/api/payments')).status).toBe(401);
  });
});

describe('GET /api/payments/:id', () => {
  it('devolve o pagamento; 404 para outra clínica ou inexistente; 400 para id inválido', async () => {
    const c = await setup();
    const p = await pending(c, await approvedBudget(c));
    const foreign = await setup();
    expect((await api().get(`/api/payments/${p.id}`).set(c.headers)).body.id).toBe(p.id);
    expect((await api().get(`/api/payments/${p.id}`).set(foreign.headers)).status).toBe(404);
    expect((await api().get('/api/payments/00000000-0000-4000-8000-000000000000').set(c.headers)).status).toBe(404);
    expect((await api().get('/api/payments/abc').set(c.headers)).status).toBe(400);
  });
});

describe('PATCH /api/payments/:id', () => {
  const patch = (c, id, body, who = c) => api().patch(`/api/payments/${id}`).set(who.headers).send(body);

  it('altera valor (dentro do saldo, sem contar a si mesma), vencimento e observações; audita os campos', async () => {
    const c = await setup();
    const b = await approvedBudget(c); // 100.000
    const p = await pending(c, b, 60000);
    await pending(c, b, 30000);
    const res = await patch(c, p.id, { amountCents: 70000, dueDate: '2099-05-05', notes: 'Renegociado' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ amountCents: 70000, dueDate: '2099-05-05', notes: 'Renegociado' });
    expect((await audit(p.id)).at(-1)).toMatchObject({ action: 'update', changes: { fields: ['amountCents', 'dueDate', 'notes'] } });
    expect((await patch(c, p.id, { notes: null })).body.notes).toBeNull();
  });

  it('valor acima do saldo: 422; só observação ou vencimento não mexe no saldo', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const p = await pending(c, b, 60000);
    await pending(c, b, 30000);
    expect((await patch(c, p.id, { amountCents: 70001 })).status).toBe(422);
    expect((await patch(c, p.id, { dueDate: '2099-07-07' })).status).toBe(200);
  });

  it('só pendente: pago ou cancelado respondem 409 PAYMENT_NOT_PENDING', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const received = await paid(c, b);
    const dropped = await pending(c, b);
    await api().post(`/api/payments/${dropped.id}/cancel`).set(c.headers).send({});
    for (const p of [received, dropped]) {
      const res = await patch(c, p.id, { notes: 'x' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PAYMENT_NOT_PENDING');
    }
  });

  it('404 para outra clínica; dentista 403; secretária pode; corpo inválido 400', async () => {
    const c = await setup();
    const p = await pending(c, await approvedBudget(c));
    const foreign = await setup();
    expect((await patch(foreign, p.id, { notes: 'invasor' })).status).toBe(404);
    const dentist = await setupUser({ role: 'dentist', clinic: c.clinic });
    expect((await patch(c, p.id, { notes: 'x' }, dentist)).status).toBe(403);
    expect((await patch(c, p.id, { notes: 'ok' }, c.secretary)).status).toBe(200);
    for (const bad of [{}, { amountCents: 0 }, { dueDate: 'amanhã' }, { notes: 'x'.repeat(501) }]) expect((await patch(c, p.id, bad)).status).toBe(400);
  });
});

describe('POST /api/payments/:id/pay', () => {
  const pay = (c, id, body, who = c) => api().post(`/api/payments/${id}/pay`).set(who.headers).send(body);

  it('registra o recebimento (agora, ou na data informada) e audita', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const p = await pending(c, b);
    const res = await pay(c, p.id, { method: 'credit_card' });
    expect(res.body).toMatchObject({ status: 'paid', method: 'credit_card', overdue: false });
    expect(res.body.paidAt).toBeTruthy();
    expect((await db('payments').where({ id: p.id }).first()).received_by).toBe(c.user.id);
    expect((await audit(p.id)).map((a) => a.action)).toEqual(['create', 'pay']);

    const q = await pending(c, b, 5000, '2020-01-01');
    const late = await pay(c, q.id, { method: 'pix', paidAt: '2026-11-03T15:00:00.000Z' });
    expect(late.body).toMatchObject({ status: 'paid', paidAt: '2026-11-03T15:00:00.000Z', overdue: false });
  });

  it('já pago ou cancelado: 409; secretária recebe; dentista 403; 404 e validações', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const p = await pending(c, b);
    const dentist = await setupUser({ role: 'dentist', clinic: c.clinic });
    expect((await pay(c, p.id, { method: 'cash' }, dentist)).status).toBe(403);
    expect((await pay(c, p.id, { method: 'cash' }, c.secretary)).status).toBe(200);
    expect((await pay(c, p.id, { method: 'cash' })).status).toBe(409);

    const dropped = await pending(c, b);
    await api().post(`/api/payments/${dropped.id}/cancel`).set(c.headers).send({});
    expect((await pay(c, dropped.id, { method: 'cash' })).status).toBe(409);

    const foreign = await setup();
    expect((await pay(foreign, p.id, { method: 'cash' })).status).toBe(404);
    const fresh = await pending(c, b);
    for (const bad of [{}, { method: 'fiado' }, { method: 'pix', paidAt: 'ontem' }]) expect((await pay(c, fresh.id, bad)).status).toBe(400);
  });
});

describe('POST /api/payments/:id/cancel', () => {
  const cancel = (c, id, body, who = c) => api().post(`/api/payments/${id}/cancel`).set(who.headers).send(body);

  it('cancela uma parcela pendente (com ou sem motivo; também sem corpo) e libera o saldo', async () => {
    const c = await setup();
    const b = await approvedBudget(c);
    const a = await pending(c, b, 100000);
    const res = await cancel(c, a.id, { reason: 'Paciente trocou o plano' });
    expect(res.body).toMatchObject({ status: 'canceled', canceledReason: 'Paciente trocou o plano' });
    expect((await audit(a.id)).at(-1)).toMatchObject({ action: 'cancel', changes: { from: 'pending' } });

    const again = await pending(c, b, 100000);
    const noBody = await api().post(`/api/payments/${again.id}/cancel`).set(c.secretary.headers);
    expect(noBody.body).toMatchObject({ status: 'canceled', canceledReason: null });
  });

  it('estorno de pagamento já recebido: só o administrador; a secretária recebe 403', async () => {
    const c = await setup();
    const p = await paid(c, await approvedBudget(c));
    expect((await cancel(c, p.id, { reason: 'Estorno' }, c.secretary)).status).toBe(403);
    const res = await cancel(c, p.id, { reason: 'Estorno' });
    expect(res.body).toMatchObject({ status: 'canceled', canceledReason: 'Estorno' });
    expect((await audit(p.id)).at(-1).changes).toEqual({ from: 'paid' });
  });

  it('cancelar de novo: 409; 404 para outra clínica; dentista 403; motivo longo demais 400', async () => {
    const c = await setup();
    const p = await pending(c, await approvedBudget(c));
    expect((await cancel(c, p.id, {})).status).toBe(200);
    const again = await cancel(c, p.id, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PAYMENT_ALREADY_CANCELED');

    const foreign = await setup();
    expect((await cancel(foreign, p.id, {})).status).toBe(404);
    const dentist = await setupUser({ role: 'dentist', clinic: c.clinic });
    expect((await cancel(c, p.id, {}, dentist)).status).toBe(403);
    const fresh = await pending(c, await approvedBudget(c));
    expect((await cancel(c, fresh.id, { reason: 'x'.repeat(241) })).status).toBe(400);
  });
});

describe('integridade no banco', () => {
  it('FK composta e CHECKs impedem dados inconsistentes mesmo sem a API', async () => {
    const c = await setup();
    const foreign = await setup();
    const b = await approvedBudget(c);
    const foreignBudget = await approvedBudget(foreign);
    const base = { clinic_id: c.clinic.id, patient_id: c.patient.id, budget_id: b.id, amount_cents: 100, due_date: '2099-01-01' };

    await expect(db('payments').insert({ ...base, budget_id: foreignBudget.id })).rejects.toThrow(/foreign key/);
    await expect(db('payments').insert({ ...base, patient_id: foreign.patient.id })).rejects.toThrow(/foreign key/);
    await expect(db('payments').insert({ ...base, amount_cents: 0 })).rejects.toThrow(/amount_check/);
    await expect(db('payments').insert({ ...base, status: 'paid' })).rejects.toThrow(/paid_check/);
    await expect(db('payments').insert({ ...base, method: 'fiado' })).rejects.toThrow(/method_check/);
    await expect(db('payments').insert({ ...base, installment: 3, installments_total: 2 })).rejects.toThrow(/installment_check/);
  });

  it('cada clínica só enxerga os próprios pagamentos', async () => {
    const a = await setup();
    const b = await setup();
    await pending(a, await approvedBudget(a));
    expect(await withTenant(b.clinic.id, (trx) => trx('payments'))).toHaveLength(0);
    expect(await withTenant(a.clinic.id, (trx) => trx('payments'))).toHaveLength(1);
  });
});
