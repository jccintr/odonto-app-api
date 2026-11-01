// Lançamentos de repasse e seus saldos: quanto já está liberado, quanto já foi pago e quanto falta pagar ao dentista.
import { config } from '../../config/env.js';
import { withTenant } from '../../db/tenant.js';
import { businessDate } from '../../utils/dates.js';
import { pageResult, paginate } from '../../utils/pagination.js';
import { toPayoutEntryDto } from '../../utils/dto.js';
import { releasedCents } from '../../utils/payouts.js';

const performedDay = `(payout_entries.performed_at AT TIME ZONE '${config.timezone.replace(/'/g, "''")}')::date`;

/** Lançamentos com nomes para exibição. `until` (AAAA-MM-DD) limita aos realizados até o dia. */
export function entriesQuery(trx, { dentistId, budgetId, from, to, until } = {}) {
  return trx('payout_entries')
    .join('budget_items', 'budget_items.id', 'payout_entries.item_id')
    .join('procedures', 'procedures.id', 'budget_items.procedure_id')
    .join('patients', 'patients.id', 'payout_entries.patient_id')
    .join('dentists', 'dentists.id', 'payout_entries.dentist_id')
    .join('users', 'users.id', 'dentists.user_id')
    .select(
      'payout_entries.*', 'budget_items.tooth', 'budget_items.faces', 'procedures.id as procedure_id', 'procedures.name as procedure_name',
      'patients.name as patient_name', 'users.name as dentist_name',
    )
    .modify((q) => {
      if (dentistId) q.where('payout_entries.dentist_id', dentistId);
      if (budgetId) q.where('payout_entries.budget_id', budgetId);
      if (from) q.whereRaw(`${performedDay} >= ?`, [from]);
      if (to) q.whereRaw(`${performedDay} <= ?`, [to]);
      if (until) q.whereRaw(`${performedDay} <= ?`, [until]);
    });
}

/**
 * Calcula liberado / pago / saldo de cada lançamento. Só conta pagamentos do paciente recebidos até `until`;
 * o que já foi repassado (fechamentos pagos, não cancelados) entra por inteiro.
 */
export async function withBalances(trx, entries, until) {
  if (entries.length === 0) return [];
  const budgetIds = [...new Set(entries.map((e) => e.budget_id))];
  const entryIds = entries.map((e) => e.id);

  const totals = new Map((await trx('budgets')
    .leftJoin(trx('budget_items').where('status', '<>', 'canceled').groupBy('budget_id').select('budget_id').sum({ subtotal: 'price_cents' }).as('items'), 'items.budget_id', 'budgets.id')
    .whereIn('budgets.id', budgetIds)
    .select('budgets.id', trx.raw('greatest(coalesce(items.subtotal, 0) - budgets.discount_cents, 0)::int AS total')))
    .map((row) => [row.id, row.total]));

  const paidByBudget = new Map();
  const received = await trx('payments')
    .whereIn('budget_id', budgetIds)
    .where('status', 'paid')
    .whereRaw(`(paid_at AT TIME ZONE '${config.timezone.replace(/'/g, "''")}')::date <= ?`, [until])
    .groupBy('budget_id', 'method')
    .select('budget_id', 'method')
    .sum({ amount: 'amount_cents' });
  for (const row of received) {
    paidByBudget.set(row.budget_id, { ...paidByBudget.get(row.budget_id), [row.method]: Number(row.amount) });
  }

  const paidOut = new Map((await trx('payout_lines')
    .join('payouts', 'payouts.id', 'payout_lines.payout_id')
    .whereIn('payout_lines.entry_id', entryIds)
    .where('payouts.status', 'paid')
    .groupBy('payout_lines.entry_id')
    .select('payout_lines.entry_id')
    .sum({ amount: 'payout_lines.amount_cents' }))
    .map((row) => [row.entry_id, Number(row.amount)]));

  return entries.map((entry) => {
    const rule = { type: entry.rule_type };
    const released = releasedCents(entry.commission_cents, rule, entry.terms, {
      totalCents: totals.get(entry.budget_id), paidByMethod: paidByBudget.get(entry.budget_id) ?? {},
    });
    const paid = paidOut.get(entry.id) ?? 0;
    return { entry, released, paid, balance: released - paid };
  });
}

export function listEntries(clinicId, filters) {
  return withTenant(clinicId, async (trx) => {
    const until = filters.until ?? businessDate();
    const [{ count }] = await entriesQuery(trx, filters).clearSelect().clearOrder().count({ count: '*' });
    const { limit, offset } = paginate(filters);
    const rows = await entriesQuery(trx, filters).orderBy([{ column: 'payout_entries.performed_at', order: 'desc' }, { column: 'payout_entries.id' }]).limit(limit).offset(offset);
    return pageResult((await withBalances(trx, rows, until)).map(toPayoutEntryDto), Number(count), filters);
  });
}

/** Saldo por dentista até a data: o que a clínica ainda deve (ou, se negativo, o que já adiantou a mais). */
export function listBalances(clinicId, { until: untilInput }) {
  return withTenant(clinicId, async (trx) => {
    const until = untilInput ?? businessDate();
    const states = await withBalances(trx, await entriesQuery(trx, { until }), until);
    const byDentist = new Map();
    for (const { entry, released, paid, balance } of states) {
      const row = byDentist.get(entry.dentist_id) ?? {
        dentist: { id: entry.dentist_id, name: entry.dentist_name }, entriesCount: 0, commissionCents: 0, releasedCents: 0, paidCents: 0, balanceCents: 0,
      };
      row.entriesCount += 1;
      row.commissionCents += entry.commission_cents;
      row.releasedCents += released;
      row.paidCents += paid;
      row.balanceCents += balance;
      byDentist.set(entry.dentist_id, row);
    }
    const data = [...byDentist.values()].sort((a, b) => a.dentist.name.localeCompare(b.dentist.name, 'pt-BR'));
    const sum = (key) => data.reduce((total, row) => total + row[key], 0);
    return {
      until, data,
      totals: { commissionCents: sum('commissionCents'), releasedCents: sum('releasedCents'), paidCents: sum('paidCents'), balanceCents: sum('balanceCents') },
    };
  });
}
