// Relatórios gerenciais. Todos os números saem direto das tabelas (nada é guardado), por mês de calendário no fuso da clínica.
import { withTenant } from '../../db/tenant.js';
import { businessDate } from '../../utils/dates.js';
import { localDate, monthRange, shiftMonth } from '../../utils/months.js';
import { listBalances } from '../payouts/payouts.entries.js';

const sum = (list, key) => list.reduce((total, row) => total + row[key], 0);
const between = (column, { from, to }) => [`${localDate(column)} BETWEEN ? AND ?`, [from, to]];
const rate = (part, total) => (total === 0 ? null : Math.round((part / total) * 1000) / 1000);

async function cashFlow(trx, range) {
  const received = await trx('payments')
    .whereNotNull('paid_at')
    .whereRaw(...between('paid_at', range))
    .groupBy('method')
    .select('method')
    .sum({ amount: 'amount_cents' });
  const [{ amount: refunded }] = await trx('payments')
    .whereNotNull('paid_at')
    .where('status', 'canceled')
    .whereRaw(...between('canceled_at', range))
    .sum({ amount: 'amount_cents' });
  const receivedCents = sum(received.map((r) => ({ amount: Number(r.amount) })), 'amount');
  const refundedCents = Number(refunded ?? 0);

  // a receber com vencimento no mês: ainda no prazo x já vencido (hoje, no fuso da clínica)
  const today = businessDate();
  const dueSum = async (compare) => {
    const row = await trx('payments').where('status', 'pending').whereBetween('due_date', [range.from, range.to]).where('due_date', compare, today).sum({ amount: 'amount_cents' }).first();
    return Number(row.amount ?? 0);
  };

  return {
    receivedCents,
    refundedCents,
    netCashCents: receivedCents - refundedCents,
    byMethod: received.map((r) => ({ method: r.method, amountCents: Number(r.amount) })).sort((a, b) => b.amountCents - a.amountCents),
    dueInMonth: { pendingCents: await dueSum('>='), overdueCents: await dueSum('<') },
  };
}

async function production(trx, range) {
  const items = trx('budget_items')
    .join('procedures', 'procedures.id', 'budget_items.procedure_id')
    .join('dentists', 'dentists.id', 'budget_items.performed_by_dentist_id')
    .join('users', 'users.id', 'dentists.user_id')
    .where('budget_items.status', 'done')
    .whereRaw(...between('budget_items.performed_at', range));
  const byDentist = await items.clone().groupBy('dentists.id', 'users.name').select('dentists.id', 'users.name').count({ count: '*' }).sum({ amount: 'budget_items.price_cents' });
  const byProcedure = await items.clone().groupBy('procedures.id', 'procedures.name').select('procedures.id', 'procedures.name').count({ count: '*' })
    .sum({ amount: 'budget_items.price_cents' }).orderBy([{ column: 'amount', order: 'desc' }, { column: 'procedures.name' }]).limit(5);
  const count = (r) => Number(r.count);
  return {
    proceduresCount: sum(byDentist.map((r) => ({ n: count(r) })), 'n'),
    producedCents: sum(byDentist.map((r) => ({ n: Number(r.amount) })), 'n'),
    topProcedures: byProcedure.map((r) => ({ procedure: { id: r.id, name: r.name }, count: count(r), producedCents: Number(r.amount) })),
    byDentist,
  };
}

async function appointments(trx, range) {
  const rows = await trx('appointments').whereRaw(...between('starts_at', range)).groupBy('status').select('status').count({ count: '*' });
  const by = Object.fromEntries(['scheduled', 'confirmed', 'attended', 'no_show', 'canceled'].map((s) => [s, Number(rows.find((r) => r.status === s)?.count ?? 0)]));
  const finished = by.attended + by.no_show;
  return { total: sum(Object.values(by).map((n) => ({ n })), 'n'), ...by, attendanceRate: rate(by.attended, finished), noShowRate: rate(by.no_show, finished) };
}

const budgetTotals = (trx) =>
  trx('budgets')
    .leftJoin(trx('budget_items').where('status', '<>', 'canceled').groupBy('budget_id').select('budget_id').sum({ subtotal: 'price_cents' }).as('items'), 'items.budget_id', 'budgets.id')
    .select('budgets.status', trx.raw('greatest(coalesce(items.subtotal, 0) - budgets.discount_cents, 0)::int AS total'));

async function budgets(trx, range) {
  const created = await budgetTotals(trx).whereRaw(...between('budgets.created_at', range));
  const approved = await budgetTotals(trx).whereRaw(...between('budgets.approved_at', range));
  const converted = created.filter((b) => ['approved', 'completed'].includes(b.status)).length;
  return {
    createdCount: created.length,
    rejectedCount: created.filter((b) => b.status === 'rejected').length,
    approvedCount: approved.length,
    approvedCents: sum(approved, 'total'),
    conversionRate: rate(converted, created.length),
  };
}

async function payouts(trx, clinicId, range) {
  const [{ amount: commission }] = await trx('payout_entries').whereRaw(...between('performed_at', range)).sum({ amount: 'commission_cents' });
  const [{ amount: paid }] = await trx('payouts').where('status', 'paid').whereRaw(...between('paid_at', range)).sum({ amount: 'total_cents' });
  const byDentist = await trx('payout_entries')
    .whereRaw(...between('performed_at', range))
    .groupBy('dentist_id')
    .select('dentist_id')
    .sum({ amount: 'commission_cents' });
  return { commissionCents: Number(commission ?? 0), paidCents: Number(paid ?? 0), byDentist };
}

/** Relatório do mês: caixa, produção, agenda, orçamentos, pacientes novos e repasse. */
export function monthlyReport(clinicId, { month: monthInput }) {
  const month = monthInput ?? businessDate().slice(0, 7);
  const range = monthRange(month);
  return withTenant(clinicId, async (trx) => {
    const cash = await cashFlow(trx, range);
    const prod = await production(trx, range);
    const pay = await payouts(trx, clinicId, range);
    const [{ count: newPatients }] = await trx('patients').whereRaw(...between('created_at', range)).count({ count: '*' });
    const attended = await trx('appointments').where('status', 'attended').whereRaw(...between('starts_at', range)).groupBy('dentist_id').select('dentist_id').count({ count: '*' });
    const balanceAtEnd = (await listBalances(clinicId, { until: range.to })).totals.balanceCents;

    const dentistIds = new Set([...prod.byDentist.map((r) => r.id), ...pay.byDentist.map((r) => r.dentist_id), ...attended.map((r) => r.dentist_id)]);
    const names = new Map((await trx('dentists').join('users', 'users.id', 'dentists.user_id').whereIn('dentists.id', [...dentistIds]).select('dentists.id', 'users.name')).map((r) => [r.id, r.name]));
    const dentists = [...dentistIds].map((id) => {
      const made = prod.byDentist.find((r) => r.id === id);
      return {
        dentist: { id, name: names.get(id) },
        proceduresCount: Number(made?.count ?? 0),
        producedCents: Number(made?.amount ?? 0),
        commissionCents: Number(pay.byDentist.find((r) => r.dentist_id === id)?.amount ?? 0),
        attendedCount: Number(attended.find((r) => r.dentist_id === id)?.count ?? 0),
      };
    }).sort((a, b) => b.producedCents - a.producedCents || a.dentist.name.localeCompare(b.dentist.name, 'pt-BR'));

    return {
      month, from: range.from, to: range.to,
      cash,
      production: { proceduresCount: prod.proceduresCount, producedCents: prod.producedCents, topProcedures: prod.topProcedures },
      appointments: await appointments(trx, range),
      budgets: await budgets(trx, range),
      newPatients: Number(newPatients),
      payouts: { commissionCents: pay.commissionCents, paidCents: pay.paidCents, balanceAtEndCents: balanceAtEnd },
      resultCents: cash.netCashCents - pay.paidCents,
      dentists,
    };
  });
}

/** Evolução mês a mês (até 12 meses, terminando em `month`): para o gráfico do painel. */
export function trendReport(clinicId, { month: monthInput, months }) {
  const last = monthInput ?? businessDate().slice(0, 7);
  const list = Array.from({ length: months }, (_, i) => shiftMonth(last, i - months + 1));
  const range = { from: monthRange(list[0]).from, to: monthRange(last).to };
  const monthOf = (column) => `to_char(${localDate(column)}, 'YYYY-MM')`;
  const grouped = async (trx, query, column, field) =>
    new Map((await query.whereRaw(...between(column, range)).groupByRaw(monthOf(column)).select(trx.raw(`${monthOf(column)} AS month`)).sum({ amount: field })).map((r) => [r.month, Number(r.amount)]));

  return withTenant(clinicId, async (trx) => {
    const received = await grouped(trx, trx('payments').whereNotNull('paid_at'), 'paid_at', 'amount_cents');
    const refunded = await grouped(trx, trx('payments').whereNotNull('paid_at').where('status', 'canceled'), 'canceled_at', 'amount_cents');
    const produced = await grouped(trx, trx('budget_items').where('status', 'done'), 'performed_at', 'price_cents');
    const paidOut = await grouped(trx, trx('payouts').where('status', 'paid'), 'paid_at', 'total_cents');
    const patients = new Map((await trx('patients').whereRaw(...between('created_at', range)).groupByRaw(monthOf('created_at')).select(trx.raw(`${monthOf('created_at')} AS month`)).count({ count: '*' })).map((r) => [r.month, Number(r.count)]));
    return {
      data: list.map((m) => ({
        month: m,
        receivedCents: received.get(m) ?? 0,
        refundedCents: refunded.get(m) ?? 0,
        producedCents: produced.get(m) ?? 0,
        payoutsPaidCents: paidOut.get(m) ?? 0,
        newPatients: patients.get(m) ?? 0,
      })),
    };
  });
}
