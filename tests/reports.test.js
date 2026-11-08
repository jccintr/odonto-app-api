import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { monthRange, shiftMonth } from '../src/utils/months.js';
import { api, createPatient } from './helpers/factories.js';
import { approvedBudget, closePayout, perform, receive, setup, settings } from './helpers/payouts.js';

const monthly = async (c, query = '') => {
  const res = await api().get(`/api/reports/monthly${query}`).set(c.headers);
  if (res.status !== 200) throw new Error(`relatório: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

// Cenário de março/2026 (mês 03) e fevereiro/2026 (mês 02), com valores conhecidos
async function scenario() {
  const c = await setup();
  await settings(c, { releaseOn: 'procedure', defaultPercent: 30 });

  const a = await approvedBudget(c, { procedures: [c.filling, c.cleaning] }); // R$ 300,00
  await perform(c, a, 0, { performedAt: '2026-03-05T12:00:00-03:00' }); // Paulo: restauração R$ 200,00
  await perform(c, a, 1, { dentistId: c.otherId, performedAt: '2026-03-20T12:00:00-03:00' }); // Bia: limpeza R$ 100,00
  const b = (await api().post('/api/budgets').set(c.headers).send({ patientId: c.patient.id, dentistId: c.id, items: [{ procedureId: c.cleaning.id }] })).body; // recusado
  await api().post(`/api/budgets/${b.id}/status`).set(c.headers).send({ status: 'rejected' });
  const open = await api().post('/api/budgets').set(c.headers).send({ patientId: c.patient.id, dentistId: c.id, items: [{ procedureId: c.cleaning.id }] });
  await db('budgets').update({ created_at: '2026-03-02T15:00:00Z' });
  await db('budgets').where({ id: a.id }).update({ approved_at: '2026-03-03T15:00:00Z' });

  // caixa: fevereiro (dinheiro, depois estornado em março) e março (pix e cartão)
  const february = await receive(c, a, 5000, 'cash', '2026-02-20T12:00:00-03:00');
  await api().post(`/api/payments/${february.id}/cancel`).set(c.headers).send({ reason: 'Devolução' });
  await db('payments').where({ id: february.id }).update({ canceled_at: '2026-03-10T15:00:00Z' });
  await receive(c, a, 12000, 'pix', '2026-03-06T12:00:00-03:00');
  await receive(c, a, 8000, 'credit_card', '2026-03-15T12:00:00-03:00');
  await api().post(`/api/budgets/${a.id}/payments`).set(c.headers).send({ amountCents: 3000, dueDate: '2026-03-25' }); // venceu e não foi pago
  await api().post(`/api/budgets/${a.id}/payments`).set(c.headers).send({ amountCents: 1500, dueDate: '2099-01-10' });

  // agenda de março do Dr. Paulo (e duas bordas de fuso)
  const slot = (day, hour, status) => ({ clinic_id: c.clinic.id, patient_id: c.patient.id, dentist_id: c.id, status, starts_at: `2026-03-${day}T${hour}:00:00Z`, ends_at: `2026-03-${day}T${Number(hour) + 1}:00:00Z` });
  await db('appointments').insert([
    slot('04', '13', 'attended'), slot('05', '13', 'attended'), slot('06', '13', 'attended'), slot('09', '13', 'no_show'),
    slot('10', '13', 'canceled'), slot('11', '13', 'scheduled'),
    { ...slot('31', '13', 'attended'), starts_at: '2026-04-01T02:00:00Z', ends_at: '2026-04-01T03:00:00Z' }, // 31/03 23:00 em Brasília
    { ...slot('01', '13', 'attended'), starts_at: '2026-03-01T02:00:00Z', ends_at: '2026-03-01T03:00:00Z' }, // 28/02 23:00 em Brasília
  ]);

  // pacientes novos
  await db('patients').update({ created_at: '2026-03-01T15:00:00Z' });
  await db('patients').insert({ clinic_id: c.clinic.id, name: 'Paciente de fevereiro', created_at: '2026-02-10T15:00:00Z' });

  const payout = await closePayout(c, { until: '2026-03-31', paidAt: '2026-03-31T12:00:00-03:00' });
  if (payout.status !== 201) throw new Error(JSON.stringify(payout.body));
  return { c, a, b, open, payout: payout.body };
}

describe('GET /api/reports/monthly', () => {
  it('reúne caixa, produção, agenda, orçamentos, pacientes e repasse do mês', async () => {
    const { c } = await scenario();
    const r = await monthly(c, '?month=2026-03');
    expect(r).toMatchObject({ month: '2026-03', from: '2026-03-01', to: '2026-03-31' });

    expect(r.cash).toEqual({
      receivedCents: 20000, refundedCents: 5000, netCashCents: 15000,
      byMethod: [{ method: 'pix', amountCents: 12000 }, { method: 'credit_card', amountCents: 8000 }],
      dueInMonth: { pendingCents: 0, overdueCents: 3000 },
    });
    expect(r.production).toEqual({
      proceduresCount: 2, producedCents: 30000,
      topProcedures: [
        { procedure: expect.objectContaining({ name: 'Restauração' }), count: 1, producedCents: 20000 },
        { procedure: expect.objectContaining({ name: 'Limpeza' }), count: 1, producedCents: 10000 },
      ],
    });
    expect(r.appointments).toEqual({ total: 7, scheduled: 1, confirmed: 0, in_progress: 0, attended: 4, no_show: 1, canceled: 1, attendanceRate: 0.8, noShowRate: 0.2 });
    expect(r.budgets).toEqual({ createdCount: 3, rejectedCount: 1, approvedCount: 1, approvedCents: 30000, conversionRate: 0.333 });
    expect(r.newPatients).toBe(1);
    expect(r.payouts).toEqual({ commissionCents: 9000, paidCents: 6000, balanceAtEndCents: 3000 });
    expect(r.resultCents).toBe(9000);
    expect(r.dentists).toEqual([
      { dentist: { id: c.id, name: 'Dr. Paulo' }, proceduresCount: 1, producedCents: 20000, commissionCents: 6000, attendedCount: 4 },
      { dentist: { id: c.otherId, name: 'Dra. Bia' }, proceduresCount: 1, producedCents: 10000, commissionCents: 3000, attendedCount: 0 },
    ]);
  });

  it('o mês seguinte mostra o que ficou para trás: sem produção, só o estorno já contado e o saldo do repasse', async () => {
    const { c } = await scenario();
    const r = await monthly(c, '?month=2026-04');
    expect(r.cash).toMatchObject({ receivedCents: 0, refundedCents: 0, netCashCents: 0, byMethod: [] });
    expect(r.production).toMatchObject({ proceduresCount: 0, producedCents: 0, topProcedures: [] });
    expect(r.appointments).toMatchObject({ total: 0, attendanceRate: null, noShowRate: null });
    expect(r.budgets).toMatchObject({ createdCount: 0, conversionRate: null });
    expect(r.payouts).toEqual({ commissionCents: 0, paidCents: 0, balanceAtEndCents: 3000 });
    expect(r.dentists).toEqual([]);
  });

  it('fevereiro conta o dinheiro que entrou na época, mesmo estornado depois; o dia segue o fuso de Brasília', async () => {
    const { c } = await scenario();
    const r = await monthly(c, '?month=2026-02');
    expect(r.cash).toMatchObject({ receivedCents: 5000, refundedCents: 0, byMethod: [{ method: 'cash', amountCents: 5000 }] });
    expect(r.appointments).toMatchObject({ total: 1, attended: 1 }); // 28/02 23:00 em Brasília (já é março em UTC)
    expect(r.newPatients).toBe(1);
  });

  it('repasse desfeito (cancelado) deixa de contar como pago e o saldo volta', async () => {
    const { c, payout } = await scenario();
    await api().post(`/api/payouts/${payout.id}/cancel`).set(c.headers).send({});
    const r = await monthly(c, '?month=2026-03');
    expect(r.payouts).toEqual({ commissionCents: 9000, paidCents: 0, balanceAtEndCents: 9000 });
    expect(r.resultCents).toBe(15000);
    const trend = (await api().get('/api/reports/trend?month=2026-03&months=1').set(c.headers)).body.data;
    expect(trend[0].payoutsPaidCents).toBe(0);
  });

  it('a parte a vencer aparece no mês certo', async () => {
    const { c } = await scenario();
    expect((await monthly(c, '?month=2099-01')).cash.dueInMonth).toEqual({ pendingCents: 1500, overdueCents: 0 });
  });

  it('sem informar o mês, usa o mês atual (Brasília); clínica sem movimento devolve zeros', async () => {
    const c = await setup();
    const r = await monthly(c);
    expect(r.month).toMatch(/^\d{4}-\d{2}$/);
    expect(r.cash).toMatchObject({ receivedCents: 0, byMethod: [] });
    expect(r).toMatchObject({ newPatients: 1, resultCents: 0, dentists: [] }); // o único paciente é o do cenário, cadastrado agora
    expect(monthRange(r.month).from).toBe(r.from);
  });

  it('isola as clínicas: números de uma não aparecem na outra', async () => {
    const { c } = await scenario();
    const other = await setup();
    const r = await monthly(other, '?month=2026-03');
    expect(r.production.proceduresCount).toBe(0);
    expect(r.cash.receivedCents).toBe(0);
    expect(c.clinic.id).not.toBe(other.clinic.id);
  });

  it('no quadro por dentista, empate em produção desempata pelo nome; dentista que só atendeu também aparece', async () => {
    const c = await setup();
    const budget = await approvedBudget(c, { procedures: [c.cleaning, c.cleaning] });
    await perform(c, budget, 0, { dentistId: c.otherId, performedAt: '2026-05-05T12:00:00-03:00' });
    await perform(c, budget, 1, { performedAt: '2026-05-06T12:00:00-03:00' });
    const r = await monthly(c, '?month=2026-05');
    expect(r.dentists.map((d) => [d.dentist.name, d.producedCents])).toEqual([['Dr. Paulo', 10000], ['Dra. Bia', 10000]]);

    await db('appointments').insert({ clinic_id: c.clinic.id, patient_id: c.patient.id, dentist_id: c.id, status: 'attended', starts_at: '2026-06-02T13:00:00Z', ends_at: '2026-06-02T14:00:00Z' });
    const june = await monthly(c, '?month=2026-06');
    expect(june.dentists).toEqual([{ dentist: { id: c.id, name: 'Dr. Paulo' }, proceduresCount: 0, producedCents: 0, commissionCents: 0, attendedCount: 1 }]);
  });

  it('rejeita mês inválido', async () => {
    const c = await setup();
    for (const month of ['2026-13', '2026-3', 'marco', '2026-00', '26-03']) {
      expect((await api().get(`/api/reports/monthly?month=${month}`).set(c.headers)).status, month).toBe(400);
    }
  });
});

describe('GET /api/reports/trend', () => {
  it('mostra os meses em sequência, zerando os sem movimento', async () => {
    const { c } = await scenario();
    const res = await api().get('/api/reports/trend?month=2026-04&months=3').set(c.headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { month: '2026-02', receivedCents: 5000, refundedCents: 0, producedCents: 0, payoutsPaidCents: 0, newPatients: 1 },
      { month: '2026-03', receivedCents: 20000, refundedCents: 5000, producedCents: 30000, payoutsPaidCents: 6000, newPatients: 1 },
      { month: '2026-04', receivedCents: 0, refundedCents: 0, producedCents: 0, payoutsPaidCents: 0, newPatients: 0 },
    ]);
  });

  it('por padrão traz 6 meses até o mês atual; cruza a virada de ano', async () => {
    const c = await setup();
    const now = (await monthly(c)).month;
    const def = (await api().get('/api/reports/trend').set(c.headers)).body.data;
    expect(def).toHaveLength(6);
    expect(def.at(-1).month).toBe(now);
    const year = (await api().get('/api/reports/trend?month=2026-02&months=4').set(c.headers)).body.data.map((m) => m.month);
    expect(year).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });

  it('valida o número de meses e o mês', async () => {
    const c = await setup();
    for (const query of ['?months=0', '?months=13', '?months=abc', '?month=2026-99']) {
      expect((await api().get(`/api/reports/trend${query}`).set(c.headers)).status, query).toBe(400);
    }
  });
});
