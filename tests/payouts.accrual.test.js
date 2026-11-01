import { describe, expect, it } from 'vitest';
import db from '../src/db/knex.js';
import { api, bearer, loginAs } from './helpers/factories.js';
import { approvedBudget, balances, dentistPercent, entries, perform, receive, rule, setup, settings } from './helpers/payouts.js';

const only = async (c, query = '') => (await entries(c, query)).data[0];

describe('lançamento ao realizar o procedimento', () => {
  it('cria o lançamento com a regra aplicada e o valor da comissão', async () => {
    const c = await setup();
    await settings(c, { releaseOn: 'procedure', defaultPercent: 30 });
    const budget = await approvedBudget(c);
    expect((await perform(c, budget)).status).toBe(200);

    expect(await only(c)).toMatchObject({
      budgetId: budget.id,
      item: { id: budget.items[0].id, procedure: { name: 'Restauração' }, tooth: null, faces: null },
      patient: { name: 'Ana Lima' }, dentist: { name: 'Dr. Paulo' },
      grossCents: 20000, costCents: 0, baseCents: 20000,
      rule: { source: 'clinic_default', type: 'percent', percent: 30, fixedCents: null },
      releaseOn: 'procedure', commissionCents: 6000, releasedCents: 6000, paidCents: 0, balanceCents: 6000,
    });
  });

  it('só gera lançamento quando o procedimento é realizado (aprovar o orçamento não basta)', async () => {
    const c = await setup();
    await approvedBudget(c);
    expect((await entries(c)).total).toBe(0);
  });

  it('um procedimento realizado gera um único lançamento; item cancelado não gera nenhum', async () => {
    const c = await setup();
    const budget = await approvedBudget(c, { procedures: [c.filling, c.cleaning] });
    await perform(c, budget, 0);
    expect((await perform(c, budget, 0)).status).toBe(409); // já finalizado: não duplica
    await api().post(`/api/budgets/${budget.id}/items/${budget.items[1].id}/cancel`).set(c.headers);
    expect((await entries(c)).total).toBe(1);
  });

  it('o lançamento é do dentista que EXECUTOU, não do dono do orçamento', async () => {
    const c = await setup();
    await dentistPercent(c, c.dentist, 20);
    await dentistPercent(c, c.other, 50);
    const budget = await approvedBudget(c, { dentistId: c.id });
    await perform(c, budget, 0, { dentistId: c.otherId });
    expect(await only(c)).toMatchObject({ dentist: { name: 'Dra. Bia' }, rule: { source: 'dentist', percent: 50 }, commissionCents: 10000 });
  });

  it('quando o próprio dentista registra a execução, o lançamento é dele', async () => {
    const c = await setup();
    const headers = bearer((await loginAs(c.dentist.user)).accessToken);
    const budget = await approvedBudget(c);
    expect((await perform(c, budget, 0, {}, headers)).status).toBe(200);
    expect((await only(c)).dentist.name).toBe('Dr. Paulo');
  });

  it('percentual do dentista, regra do procedimento e regra do dentista no procedimento, nessa ordem de prioridade', async () => {
    const c = await setup();
    await settings(c, { releaseOn: 'procedure', defaultPercent: 10 });
    await dentistPercent(c, c.dentist, 30);
    const run = async () => {
      const budget = await approvedBudget(c);
      await perform(c, budget, 0);
      return (await entries(c, `?budgetId=${budget.id}`)).data[0];
    };
    expect(await run()).toMatchObject({ rule: { source: 'dentist', percent: 30 }, commissionCents: 6000 });
    await rule(c, { procedureId: c.filling.id, type: 'fixed', fixedCents: 5000 });
    expect(await run()).toMatchObject({ rule: { source: 'procedure', type: 'fixed', fixedCents: 5000, percent: null }, commissionCents: 5000 });
    await rule(c, { procedureId: c.filling.id, dentistId: c.id, type: 'percent', percent: 50 });
    expect(await run()).toMatchObject({ rule: { source: 'dentist_procedure', percent: 50 }, commissionCents: 10000 });
  });

  it('desconta o custo do procedimento da base, se a clínica optar (o custo nunca passa do valor cobrado)', async () => {
    const c = await setup();
    await settings(c, { releaseOn: 'procedure', deductCosts: true, defaultPercent: 40 });
    const full = await approvedBudget(c);
    await perform(c, full, 0);
    expect(await only(c)).toMatchObject({ grossCents: 20000, costCents: 5000, baseCents: 15000, commissionCents: 6000 });

    const cheap = await approvedBudget(c, { discountCents: 18000 }); // o paciente paga só R$ 20,00 por uma restauração de custo R$ 50,00
    await perform(c, cheap, 0);
    expect((await entries(c, `?budgetId=${cheap.id}`)).data[0]).toMatchObject({ grossCents: 2000, costCents: 2000, baseCents: 0, commissionCents: 0 });
  });

  it('sem a opção de descontar custos, o custo cadastrado é ignorado', async () => {
    const c = await setup();
    await settings(c, { releaseOn: 'procedure', defaultPercent: 40 });
    await perform(c, await approvedBudget(c), 0);
    expect(await only(c)).toMatchObject({ costCents: 0, baseCents: 20000, commissionCents: 8000 });
  });

  it('o desconto do orçamento é dividido entre os itens, proporcionalmente ao preço', async () => {
    const c = await setup();
    await settings(c, { releaseOn: 'procedure', defaultPercent: 50 });
    const budget = await approvedBudget(c, { procedures: [c.filling, c.cleaning], discountCents: 3000 });
    await perform(c, budget, 0);
    await perform(c, budget, 1);
    const byName = Object.fromEntries((await entries(c)).data.map((e) => [e.item.procedure.name, e]));
    expect(byName['Restauração']).toMatchObject({ grossCents: 18000, commissionCents: 9000 });
    expect(byName['Limpeza']).toMatchObject({ grossCents: 9000, commissionCents: 4500 });
  });

  it('valor fixo não depende da base, nem do custo, nem do desconto', async () => {
    const c = await setup();
    await settings(c, { releaseOn: 'procedure', deductCosts: true });
    await rule(c, { procedureId: c.filling.id, type: 'fixed', fixedCents: 2500 });
    await perform(c, await approvedBudget(c, { discountCents: 10000 }), 0);
    expect(await only(c)).toMatchObject({ grossCents: 10000, costCents: 5000, commissionCents: 2500 });
  });

  it('mudar a configuração ou as regras depois não altera lançamentos já feitos (vale só daqui para frente)', async () => {
    const c = await setup();
    await settings(c, { releaseOn: 'procedure', defaultPercent: 30 });
    const first = await approvedBudget(c);
    await perform(c, first, 0);
    await settings(c, { releaseOn: 'payment', defaultPercent: 60, deductCosts: true });
    await rule(c, { procedureId: c.filling.id, type: 'fixed', fixedCents: 1 });
    const second = await approvedBudget(c);
    await perform(c, second, 0);

    expect((await entries(c, `?budgetId=${first.id}`)).data[0]).toMatchObject({ releaseOn: 'procedure', commissionCents: 6000, releasedCents: 6000, rule: { source: 'clinic_default', percent: 30 } });
    expect((await entries(c, `?budgetId=${second.id}`)).data[0]).toMatchObject({ releaseOn: 'payment', commissionCents: 1, releasedCents: 0, rule: { source: 'procedure' } });
  });

  it('os lançamentos nunca são alterados nem apagados pela aplicação (nem por engano)', async () => {
    const c = await setup();
    await perform(c, await approvedBudget(c), 0);
    const { withTenant } = await import('../src/db/tenant.js');
    await expect(withTenant(c.clinic.id, (trx) => trx('payout_entries').update({ commission_cents: 999999 }))).rejects.toThrow(/permission denied/);
    await expect(withTenant(c.clinic.id, (trx) => trx('payout_entries').del())).rejects.toThrow(/permission denied/);
    expect(await db('payout_entries')).toHaveLength(1);
  });
});

describe('liberação pelo pagamento do paciente', () => {
  const run = async (settingsBody = {}) => {
    const c = await setup();
    await settings(c, { releaseOn: 'payment', defaultPercent: 30, ...settingsBody });
    const budget = await approvedBudget(c); // R$ 200,00 → comissão de R$ 60,00
    await perform(c, budget, 0);
    return { c, budget };
  };

  it('sem pagamento nada é liberado; cada recebimento libera a parte proporcional', async () => {
    const { c, budget } = await run();
    expect(await only(c)).toMatchObject({ commissionCents: 6000, releasedCents: 0, balanceCents: 0 });
    await receive(c, budget, 5000);
    expect(await only(c)).toMatchObject({ releasedCents: 1500, balanceCents: 1500 });
    await receive(c, budget, 15000);
    expect(await only(c)).toMatchObject({ releasedCents: 6000, balanceCents: 6000 });
  });

  it('parcela a receber (ainda não paga) não libera nada', async () => {
    const { c, budget } = await run();
    await api().post(`/api/budgets/${budget.id}/payment-plan`).set(c.headers).send({ installments: 4, firstDueDate: '2099-01-10' });
    expect((await only(c)).releasedCents).toBe(0);
  });

  it('pagamento recebido depois da data consultada não conta; o fuso de Brasília define o dia', async () => {
    const c = await setup();
    await settings(c, { releaseOn: 'payment', defaultPercent: 30 });
    const budget = await approvedBudget(c);
    await perform(c, budget, 0, { performedAt: '2026-03-01T12:00:00-03:00' });
    await receive(c, budget, 20000, 'pix', '2026-03-02T01:30:00Z'); // 01/03 22:30 em Brasília
    expect((await only(c, '?until=2026-02-28')) ?? null).toBeNull(); // nem foi realizado ainda
    expect(await only(c, '?until=2026-03-01')).toMatchObject({ releasedCents: 6000 });

    const second = await approvedBudget(c);
    await perform(c, second, 0, { performedAt: '2026-03-01T12:00:00-03:00' });
    await receive(c, second, 20000, 'pix', '2026-03-05T12:00:00-03:00');
    expect((await entries(c, `?budgetId=${second.id}&until=2026-03-04`)).data[0].releasedCents).toBe(0);
    expect((await entries(c, `?budgetId=${second.id}&until=2026-03-05`)).data[0].releasedCents).toBe(6000);
  });

  it('estornar um pagamento já recebido reduz o que estava liberado', async () => {
    const { c, budget } = await run();
    const payment = await receive(c, budget, 20000);
    expect((await only(c)).releasedCents).toBe(6000);
    await api().post(`/api/payments/${payment.id}/cancel`).set(c.headers).send({ reason: 'Cheque devolvido' });
    expect(await only(c)).toMatchObject({ releasedCents: 0, balanceCents: 0 });
  });

  it('desconta a taxa do cartão de crédito e de débito só de comissões em percentual', async () => {
    const { c, budget } = await run({ deductCardFees: true, creditCardFeePercent: 5, debitCardFeePercent: 2 });
    await receive(c, budget, 10000, 'credit_card');
    await receive(c, budget, 10000, 'debit_card');
    // líquido: 9500 + 9800 = 19300 de 20000 → 60,00 × 96,5% = 57,90
    expect(await only(c)).toMatchObject({ commissionCents: 6000, releasedCents: 5790 });

    await rule(c, { procedureId: c.cleaning.id, type: 'fixed', fixedCents: 3000 });
    const fixed = await approvedBudget(c, { procedures: [c.cleaning] });
    await perform(c, fixed, 0);
    await receive(c, fixed, 10000, 'credit_card');
    expect((await entries(c, `?budgetId=${fixed.id}`)).data[0]).toMatchObject({ commissionCents: 3000, releasedCents: 3000 });
  });

  it('com a opção de taxas desligada, cartão e pix liberam igual', async () => {
    const { c, budget } = await run({ deductCardFees: false, creditCardFeePercent: 5 });
    await receive(c, budget, 20000, 'credit_card');
    expect((await only(c)).releasedCents).toBe(6000);
  });

  it('cancelar itens não realizados reduz o total do orçamento, e o que foi pago passa a valer mais', async () => {
    const c = await setup();
    await settings(c, { releaseOn: 'payment', defaultPercent: 50 });
    const budget = await approvedBudget(c, { procedures: [c.filling, c.cleaning] });
    await perform(c, budget, 0);
    await receive(c, budget, 10000);
    expect((await only(c)).releasedCents).toBe(3333); // 10.000 de 30.000 do orçamento
    await api().post(`/api/budgets/${budget.id}/items/${budget.items[1].id}/cancel`).set(c.headers);
    expect((await only(c)).releasedCents).toBe(5000); // 10.000 de 20.000
  });
});

describe('lista de lançamentos', () => {
  async function seed() {
    const c = await setup();
    await settings(c, { releaseOn: 'procedure', defaultPercent: 10 });
    const jan = await approvedBudget(c);
    const feb = await approvedBudget(c, { dentistId: c.otherId });
    await perform(c, jan, 0, { performedAt: '2026-01-10T12:00:00-03:00' });
    await perform(c, feb, 0, { dentistId: c.otherId, performedAt: '2026-02-10T12:00:00-03:00' });
    return { c, jan, feb };
  }

  it('mostra o mais recente primeiro e pagina', async () => {
    const { c } = await seed();
    const page1 = await entries(c, '?perPage=1');
    expect(page1).toMatchObject({ page: 1, perPage: 1, total: 2, totalPages: 2 });
    expect(page1.data[0].dentist.name).toBe('Dra. Bia');
    expect((await entries(c, '?perPage=1&page=2')).data[0].dentist.name).toBe('Dr. Paulo');
  });

  it('filtra por dentista, orçamento e período de realização', async () => {
    const { c, jan, feb } = await seed();
    expect((await entries(c, `?dentistId=${c.id}`)).data.map((e) => e.budgetId)).toEqual([jan.id]);
    expect((await entries(c, `?budgetId=${feb.id}`)).data.map((e) => e.budgetId)).toEqual([feb.id]);
    expect((await entries(c, '?from=2026-02-01')).total).toBe(1);
    expect((await entries(c, '?to=2026-01-31')).total).toBe(1);
    expect((await entries(c, '?from=2026-01-01&to=2026-12-31')).total).toBe(2);
    expect((await entries(c, '?from=2027-01-01')).total).toBe(0);
  });

  it('datas e identificadores inválidos dão 400', async () => {
    const c = await setup();
    for (const query of ['?from=ontem', '?until=2026-13-40', '?dentistId=abc', '?page=0']) {
      expect((await api().get(`/api/payouts/entries${query}`).set(c.headers)).status, query).toBe(400);
    }
  });
});

describe('saldo por dentista', () => {
  it('sem lançamentos devolve lista vazia e totais zerados, com a data de hoje (Brasília)', async () => {
    const c = await setup();
    const res = await balances(c);
    expect(res.data).toEqual([]);
    expect(res.totals).toEqual({ commissionCents: 0, releasedCents: 0, paidCents: 0, balanceCents: 0 });
    expect(res.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('soma por dentista, em ordem alfabética, com o total geral', async () => {
    const c = await setup();
    await settings(c, { releaseOn: 'procedure', defaultPercent: 10 });
    await dentistPercent(c, c.other, 50);
    const a = await approvedBudget(c, { procedures: [c.filling, c.cleaning] });
    const b = await approvedBudget(c, { dentistId: c.otherId });
    await perform(c, a, 0);
    await perform(c, a, 1);
    await perform(c, b, 0, { dentistId: c.otherId });
    const res = await balances(c);
    expect(res.data).toEqual([
      { dentist: { id: c.id, name: 'Dr. Paulo' }, entriesCount: 2, commissionCents: 3000, releasedCents: 3000, paidCents: 0, balanceCents: 3000 },
      { dentist: { id: c.otherId, name: 'Dra. Bia' }, entriesCount: 1, commissionCents: 10000, releasedCents: 10000, paidCents: 0, balanceCents: 10000 },
    ]);
    expect(res.totals).toEqual({ commissionCents: 13000, releasedCents: 13000, paidCents: 0, balanceCents: 13000 });
  });

  it('considera só o que foi realizado até a data informada', async () => {
    const c = await setup();
    await settings(c, { releaseOn: 'procedure', defaultPercent: 10 });
    await perform(c, await approvedBudget(c), 0, { performedAt: '2026-01-10T12:00:00-03:00' });
    await perform(c, await approvedBudget(c), 0, { performedAt: '2026-02-10T12:00:00-03:00' });
    expect((await balances(c, '?until=2026-01-31')).totals.balanceCents).toBe(2000);
    expect((await balances(c, '?until=2026-02-28')).totals.balanceCents).toBe(4000);
    expect((await balances(c, '?until=2025-12-31')).data).toEqual([]);
    expect((await api().get('/api/payouts/balances?until=hoje').set(c.headers)).status).toBe(400);
  });
});
