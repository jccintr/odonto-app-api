// Fechamentos: o administrador paga ao dentista o saldo liberado até uma data. Cancelar um fechamento devolve o saldo.
import { withTenant } from '../../db/tenant.js';
import { recordAudit } from '../../services/audit.js';
import { conflict, notFound, unprocessable } from '../../utils/errors.js';
import { businessDate } from '../../utils/dates.js';
import { pageResult, paginate } from '../../utils/pagination.js';
import { toPayoutDto } from '../../utils/dto.js';
import { entriesQuery, withBalances } from './payouts.entries.js';

const payoutsQuery = (trx) =>
  trx('payouts')
    .join('dentists', 'dentists.id', 'payouts.dentist_id')
    .join('users', 'users.id', 'dentists.user_id')
    .select('payouts.*', 'users.name as dentist_name');

const audit = (trx, auth, id, action, changes) =>
  recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'payout', entityId: id, action, changes });

async function detail(trx, id) {
  const payout = await payoutsQuery(trx).where('payouts.id', id).first();
  if (!payout) throw notFound('Fechamento de repasse');
  const lines = await trx('payout_lines')
    .join('payout_entries', 'payout_entries.id', 'payout_lines.entry_id')
    .join('budget_items', 'budget_items.id', 'payout_entries.item_id')
    .join('procedures', 'procedures.id', 'budget_items.procedure_id')
    .join('patients', 'patients.id', 'payout_entries.patient_id')
    .where('payout_lines.payout_id', id)
    .orderBy('payout_entries.performed_at')
    .select('payout_lines.entry_id', 'payout_lines.amount_cents', 'payout_entries.performed_at', 'procedures.name as procedure_name', 'patients.name as patient_name');
  return {
    ...toPayoutDto(payout),
    lines: lines.map((l) => ({
      entryId: l.entry_id, amountCents: l.amount_cents, performedAt: l.performed_at, procedure: l.procedure_name, patient: l.patient_name,
    })),
  };
}

/**
 * Paga o dentista: soma o saldo (liberado - já pago) de cada lançamento realizado até `until`.
 * Saldos negativos (pagamento do paciente estornado depois do repasse) são descontados no mesmo fechamento.
 */
export function createPayout(auth, { dentistId, until: untilInput, method, paidAt, notes }) {
  return withTenant(auth.clinicId, async (trx) => {
    // trava o dentista: dois fechamentos simultâneos não pagam o mesmo saldo duas vezes
    if (!(await trx('dentists').where({ id: dentistId }).forUpdate().first('id'))) throw notFound('Dentista');
    const until = untilInput ?? businessDate();
    const states = (await withBalances(trx, await entriesQuery(trx, { dentistId, until }), until)).filter((s) => s.balance !== 0);
    const total = states.reduce((sum, s) => sum + s.balance, 0);
    if (total <= 0) throw unprocessable('Não há saldo a repassar a este dentista até a data informada.', { code: 'NOTHING_TO_PAY' });

    const [{ id }] = await trx('payouts')
      .insert({
        clinic_id: auth.clinicId, dentist_id: dentistId, until, total_cents: total, method,
        paid_at: paidAt ? new Date(paidAt) : new Date(), paid_by: auth.userId, notes,
      })
      .returning('id');
    await trx('payout_lines').insert(states.map((s) => ({ clinic_id: auth.clinicId, payout_id: id, entry_id: s.entry.id, amount_cents: s.balance })));
    await audit(trx, auth, id, 'create');
    return detail(trx, id);
  });
}

export function listPayouts(clinicId, filters) {
  const apply = (query) =>
    query.modify((q) => {
      if (filters.dentistId) q.where('payouts.dentist_id', filters.dentistId);
      if (filters.status) q.where('payouts.status', filters.status);
    });
  return withTenant(clinicId, async (trx) => {
    const [{ count }] = await apply(trx('payouts')).count({ count: '*' });
    const { limit, offset } = paginate(filters);
    const rows = await apply(payoutsQuery(trx)).orderBy([{ column: 'payouts.paid_at', order: 'desc' }, { column: 'payouts.id' }]).limit(limit).offset(offset);
    return pageResult(rows.map(toPayoutDto), Number(count), filters);
  });
}

export function getPayout(clinicId, id) {
  return withTenant(clinicId, (trx) => detail(trx, id));
}

/** Desfaz o fechamento (ex.: pagamento não saiu). Os lançamentos voltam a ter saldo. */
export function cancelPayout(auth, id, { reason }) {
  return withTenant(auth.clinicId, async (trx) => {
    const payout = await trx('payouts').where({ id }).forUpdate().first('id', 'status');
    if (!payout) throw notFound('Fechamento de repasse');
    if (payout.status === 'canceled') throw conflict('Este fechamento já está cancelado.', { code: 'PAYOUT_ALREADY_CANCELED' });
    await trx('payouts').where({ id }).update({ status: 'canceled', canceled_reason: reason ?? null, canceled_at: new Date(), canceled_by: auth.userId, updated_at: new Date() });
    await audit(trx, auth, id, 'cancel');
    return detail(trx, id);
  });
}
