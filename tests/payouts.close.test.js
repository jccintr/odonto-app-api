import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { withTenant } from '../src/db/tenant.js';
import { api } from './helpers/factories.js';
import { approvedBudget, balances, closePayout, entries, perform, receive, setup, settings } from './helpers/payouts.js';

const NOBODY = '0b0d2f7e-8f7b-4d49-9d63-3c2f1f2a1b11';

// dentista com R$ 90,00 liberados: restauração (30% de 200 = 60) + limpeza (30% de 100 = 30), liberação na execução
async function withBalance() {
  const c = await setup();
  await settings(c, { releaseOn: 'procedure', defaultPercent: 30 });
  const budget = await approvedBudget(c, { procedures: [c.filling, c.cleaning] });
  await perform(c, budget, 0, { performedAt: '2026-01-10T12:00:00-03:00' });
  await perform(c, budget, 1, { performedAt: '2026-02-10T12:00:00-03:00' });
  return { c, budget };
}

describe('POST /api/payouts (pagar o repasse)', () => {
  it('paga o saldo liberado, registra as linhas e zera o saldo do dentista', async () => {
    const { c } = await withBalance();
    const res = await closePayout(c, { notes: 'Fechamento de fevereiro', paidAt: '2026-03-01T10:00:00-03:00' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      dentist: { name: 'Dr. Paulo' }, totalCents: 9000, method: 'pix', status: 'paid', notes: 'Fechamento de fevereiro', paidAt: '2026-03-01T13:00:00.000Z',
    });
    expect(res.body.lines.map((l) => [l.procedure, l.patient, l.amountCents])).toEqual([['Restauração', 'Ana Lima', 6000], ['Limpeza', 'Ana Lima', 3000]]);

    const after = await entries(c);
    expect(after.data.map((e) => [e.paidCents, e.balanceCents])).toEqual([[3000, 0], [6000, 0]]);
    expect((await balances(c)).totals).toMatchObject({ paidCents: 9000, balanceCents: 0 });
    expect(await db('audit_log').where({ entity: 'payout', action: 'create' })).toHaveLength(1);
  });

  it('não paga duas vezes o mesmo saldo', async () => {
    const { c } = await withBalance();
    expect((await closePayout(c)).status).toBe(201);
    const again = await closePayout(c);
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('NOTHING_TO_PAY');
    expect(await db('payouts')).toHaveLength(1);
  });

  it('respeita a data de corte: o que foi realizado depois fica para o próximo fechamento', async () => {
    const { c } = await withBalance();
    const january = await closePayout(c, { until: '2026-01-31' });
    expect(january.body).toMatchObject({ totalCents: 6000, until: '2026-01-31' });
    const rest = await closePayout(c, { until: '2026-02-28' });
    expect(rest.body.totalCents).toBe(3000);
    expect((await closePayout(c, { until: '2026-12-31' })).status).toBe(422);
  });

  it('sem saldo até a data (ou sem nenhum lançamento) responde 422 e não grava nada', async () => {
    const { c } = await withBalance();
    expect((await closePayout(c, { until: '2025-12-31' })).status).toBe(422);
    const empty = await setup();
    expect((await closePayout(empty)).status).toBe(422);
    expect(await db('payouts')).toHaveLength(0);
    expect(await db('payout_lines')).toHaveLength(0);
  });

  it('só o dentista informado é pago; o saldo dos outros fica intacto', async () => {
    const { c } = await withBalance();
    const budget = await approvedBudget(c, { dentistId: c.otherId });
    await perform(c, budget, 0, { dentistId: c.otherId });
    await closePayout(c);
    const rest = (await balances(c)).data;
    expect(rest.map((r) => [r.dentist.name, r.balanceCents])).toEqual([['Dr. Paulo', 0], ['Dra. Bia', 6000]]);
  });

  it('no modo "pelo pagamento", paga conforme o paciente vai pagando, sem repetir o que já foi pago', async () => {
    const c = await setup();
    await settings(c, { releaseOn: 'payment', defaultPercent: 30 });
    const budget = await approvedBudget(c);
    await perform(c, budget, 0);
    expect((await closePayout(c)).status).toBe(422); // nada recebido ainda

    await receive(c, budget, 10000);
    expect((await closePayout(c)).body.totalCents).toBe(3000);
    expect((await closePayout(c)).status).toBe(422);
    await receive(c, budget, 10000);
    expect((await closePayout(c)).body.totalCents).toBe(3000);
    expect((await entries(c)).data[0]).toMatchObject({ commissionCents: 6000, releasedCents: 6000, paidCents: 6000, balanceCents: 0 });
  });

  it('estorno de pagamento já repassado vira desconto no próximo fechamento', async () => {
    const c = await setup();
    await settings(c, { releaseOn: 'payment', defaultPercent: 30 });
    const first = await approvedBudget(c);
    await perform(c, first, 0);
    const payment = await receive(c, first, 20000);
    expect((await closePayout(c)).body.totalCents).toBe(6000);

    await api().post(`/api/payments/${payment.id}/cancel`).set(c.headers).send({ reason: 'Cartão contestado' });
    expect((await entries(c)).data[0]).toMatchObject({ releasedCents: 0, paidCents: 6000, balanceCents: -6000 });
    expect((await balances(c)).totals.balanceCents).toBe(-6000);
    expect((await closePayout(c)).status).toBe(422); // não há o que pagar, só o que descontar

    const second = await approvedBudget(c, { procedures: [c.filling, c.cleaning] });
    await perform(c, second, 0);
    await perform(c, second, 1);
    await receive(c, second, 30000);
    const res = await closePayout(c);
    expect(res.status).toBe(201);
    expect(res.body.totalCents).toBe(9000 - 6000);
    expect(res.body.lines.map((l) => l.amountCents).sort((a, b) => a - b)).toEqual([-6000, 3000, 6000]);
    expect((await balances(c)).totals.balanceCents).toBe(0);
  });

  it('dois fechamentos simultâneos nunca pagam o mesmo saldo duas vezes', async () => {
    const { c } = await withBalance();
    const results = await Promise.all([closePayout(c), closePayout(c), closePayout(c)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422, 422]);
    expect(await db('payouts')).toHaveLength(1);
    expect(Number((await db('payout_lines').sum({ total: 'amount_cents' }).first()).total)).toBe(9000);
  });

  it('valida os dados e o dentista', async () => {
    const { c } = await withBalance();
    const bad = (body) => api().post('/api/payouts').set(c.headers).send(body);
    expect((await bad({ dentistId: c.id })).status).toBe(400); // sem forma de pagamento
    expect((await bad({ dentistId: c.id, method: 'ouro' })).status).toBe(400);
    expect((await bad({ dentistId: 'x', method: 'pix' })).status).toBe(400);
    expect((await bad({ dentistId: c.id, method: 'pix', until: '31/01/2026' })).status).toBe(400);
    expect((await bad({ dentistId: c.id, method: 'pix', paidAt: 'ontem' })).status).toBe(400);
    expect((await bad({ dentistId: NOBODY, method: 'pix' })).status).toBe(404);
    const stranger = await setup();
    expect((await bad({ dentistId: stranger.id, method: 'pix' })).status).toBe(404);
    expect(await db('payouts')).toHaveLength(0);
  });

  it('o banco recusa fechamento de valor zero e linha de valor zero', async () => {
    const { c } = await withBalance();
    const base = { clinic_id: c.clinic.id, dentist_id: c.id, until: '2026-01-31', method: 'pix', paid_at: new Date() };
    await expect(db('payouts').insert({ ...base, total_cents: 0 })).rejects.toThrow();
    await expect(db('payouts').insert({ ...base, total_cents: 100, method: 'ouro' })).rejects.toThrow();
    const [payout] = await db('payouts').insert({ ...base, total_cents: 100 }).returning('*');
    const entry = await db('payout_entries').first();
    await expect(db('payout_lines').insert({ clinic_id: c.clinic.id, payout_id: payout.id, entry_id: entry.id, amount_cents: 0 })).rejects.toThrow();
  });

  it('as linhas de um fechamento nunca são alteradas nem apagadas pela aplicação', async () => {
    const { c } = await withBalance();
    await closePayout(c);
    await expect(withTenant(c.clinic.id, (trx) => trx('payout_lines').update({ amount_cents: 1 }))).rejects.toThrow(/permission denied/);
    await expect(withTenant(c.clinic.id, (trx) => trx('payout_lines').del())).rejects.toThrow(/permission denied/);
    await expect(withTenant(c.clinic.id, (trx) => trx('payouts').del())).rejects.toThrow(/permission denied/);
  });
});

describe('consulta de fechamentos', () => {
  it('lista do mais recente para o mais antigo, com filtros e paginação', async () => {
    const { c } = await withBalance();
    const budget = await approvedBudget(c, { dentistId: c.otherId });
    await perform(c, budget, 0, { dentistId: c.otherId });
    const first = await closePayout(c, { paidAt: '2026-03-01T10:00:00-03:00' });
    const second = await closePayout(c, { dentistId: c.otherId, paidAt: '2026-04-01T10:00:00-03:00' });
    await api().post(`/api/payouts/${second.body.id}/cancel`).set(c.headers).send({});

    const all = (await api().get('/api/payouts').set(c.headers)).body;
    expect(all.data.map((p) => p.id)).toEqual([second.body.id, first.body.id]);
    expect(all.data[0]).not.toHaveProperty('lines');
    expect((await api().get(`/api/payouts?dentistId=${c.id}`).set(c.headers)).body.data.map((p) => p.id)).toEqual([first.body.id]);
    expect((await api().get('/api/payouts?status=canceled').set(c.headers)).body.data.map((p) => p.id)).toEqual([second.body.id]);
    expect((await api().get('/api/payouts?perPage=1&page=2').set(c.headers)).body).toMatchObject({ total: 2, totalPages: 2, data: [{ id: first.body.id }] });
    expect((await api().get('/api/payouts?status=pago').set(c.headers)).status).toBe(400);
  });

  it('consulta um fechamento com as linhas; id desconhecido dá 404', async () => {
    const { c } = await withBalance();
    const created = await closePayout(c);
    const res = await api().get(`/api/payouts/${created.body.id}`).set(c.headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
    expect((await api().get(`/api/payouts/${NOBODY}`).set(c.headers)).status).toBe(404);
  });
});

describe('POST /api/payouts/:id/cancel (desfazer fechamento)', () => {
  it('devolve o saldo aos lançamentos e permite pagar de novo', async () => {
    const { c } = await withBalance();
    const created = await closePayout(c);
    const res = await api().post(`/api/payouts/${created.body.id}/cancel`).set(c.headers).send({ reason: 'Pix não saiu' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'canceled', canceledReason: 'Pix não saiu' });
    expect(res.body.canceledAt).toBeTruthy();
    expect(res.body.lines).toHaveLength(2); // o histórico continua

    expect((await balances(c)).totals).toMatchObject({ paidCents: 0, balanceCents: 9000 });
    const again = await closePayout(c);
    expect(again.status).toBe(201);
    expect(again.body.totalCents).toBe(9000);
  });

  it('não cancela duas vezes nem fechamento inexistente', async () => {
    const { c } = await withBalance();
    const created = await closePayout(c);
    await api().post(`/api/payouts/${created.body.id}/cancel`).set(c.headers).send({});
    const twice = await api().post(`/api/payouts/${created.body.id}/cancel`).set(c.headers).send({});
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('PAYOUT_ALREADY_CANCELED');
    expect((await api().post(`/api/payouts/${NOBODY}/cancel`).set(c.headers).send({})).status).toBe(404);
    expect(await db('audit_log').where({ entity: 'payout', action: 'cancel' })).toHaveLength(1);
  });
});
