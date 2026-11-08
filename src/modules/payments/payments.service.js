import { withTenant } from '../../db/tenant.js';
import { recordAudit } from '../../services/audit.js';
import { conflict, forbidden, notFound, unprocessable } from '../../utils/errors.js';
import { toPaymentDto } from '../../utils/dto.js';
import { addMonths, businessDate, splitAmount } from '../../utils/dates.js';
import { pageResult, paginate } from '../../utils/pagination.js';
import { findBudgetSummary, listApprovals } from '../budgets/budgets.service.js';

const COLUMN = { amountCents: 'amount_cents', dueDate: 'due_date' };
const toColumns = (input) => Object.fromEntries(Object.entries(input).map(([key, value]) => [COLUMN[key] ?? key, value]));

// "vencida" = pendente com vencimento antes de hoje (no fuso da clínica)
const paymentsQuery = (trx) =>
  trx('payments')
    .join('patients', 'patients.id', 'payments.patient_id')
    .select('payments.*', 'patients.name as patient_name', trx.raw("(payments.status = 'pending' AND payments.due_date < ?) AS overdue", [businessDate()]));

const findPayment = (trx, id) => paymentsQuery(trx).where('payments.id', id).first();

async function loadPayment(trx, id) {
  const payment = await findPayment(trx, id);
  if (!payment) throw notFound('Pagamento');
  return payment;
}

const audit = (trx, auth, id, action, changes) =>
  recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'payment', entityId: id, action, changes });

// ---- saldo do orçamento ----

/** Trava a linha do orçamento até o fim da transação: dois lançamentos simultâneos não estouram o saldo. */
async function lockBudget(trx, budgetId) {
  if (!(await trx('budgets').where({ id: budgetId }).forUpdate().first('id'))) throw notFound('Orçamento');
  return findBudgetSummary(trx, budgetId);
}

const assertReceivable = (budget) => {
  if (!['approved', 'completed'].includes(budget.status)) {
    throw conflict('Só é possível lançar pagamentos em orçamentos aprovados.', { code: 'BUDGET_NOT_APPROVED' });
  }
};

// cada rodada de aprovação tem o próprio desconto e as próprias parcelas: o saldo é por rodada
const approvalTotal = (approval) => Math.max(approval.subtotal - approval.discount_cents, 0);

/** Rodada a que o lançamento pertence: a informada, ou a única do orçamento. Com várias rodadas é preciso dizer qual. */
async function resolveApproval(trx, budgetId, approvalId) {
  const approvals = await listApprovals(trx, budgetId);
  if (approvalId) {
    const found = approvals.find((approval) => approval.id === approvalId);
    if (!found) throw notFound('Rodada de aprovação');
    return found;
  }
  if (approvals.length === 1) return approvals[0];
  throw unprocessable('Este orçamento tem mais de uma rodada de aprovação: informe qual.', { code: 'APPROVAL_REQUIRED' });
}

// soma do que já foi lançado na rodada (pendente + pago); cancelados não contam
async function scheduledCents(trx, approvalId, exceptPaymentId = null) {
  const [{ sum }] = await trx('payments')
    .where({ approval_id: approvalId })
    .whereNot('status', 'canceled')
    .modify((query) => { if (exceptPaymentId) query.whereNot('id', exceptPaymentId); })
    .sum({ sum: 'amount_cents' });
  return Number(sum ?? 0);
}

const assertWithinBalance = (amount, balance) => {
  if (amount > balance) throw unprocessable('O valor ultrapassa o saldo do orçamento.', { code: 'EXCEEDS_BALANCE', balanceCents: balance });
};

// ---- lançamentos de um orçamento ----

/** Recebimento na hora (paidAt + method) ou parcela a receber (dueDate). */
export function createPayment(auth, budgetId, input) {
  return withTenant(auth.clinicId, async (trx) => {
    const budget = await lockBudget(trx, budgetId);
    assertReceivable(budget);
    const approval = await resolveApproval(trx, budgetId, input.approvalId);
    assertWithinBalance(input.amountCents, approvalTotal(approval) - (await scheduledCents(trx, approval.id)));

    const paidAt = input.paidAt ? new Date(input.paidAt) : null;
    const [{ id }] = await trx('payments')
      .insert({
        clinic_id: auth.clinicId, patient_id: budget.patient_id, budget_id: budgetId, approval_id: approval.id, amount_cents: input.amountCents,
        due_date: input.dueDate ?? businessDate(paidAt), status: paidAt ? 'paid' : 'pending', method: input.method, paid_at: paidAt,
        received_by: paidAt ? auth.userId : null, notes: input.notes, created_by: auth.userId,
      })
      .returning('id');
    await audit(trx, auth, id, 'create');
    return toPaymentDto(await findPayment(trx, id));
  });
}

/** Gera parcelas mensais (mesmo dia de cada mês) com o saldo do orçamento, ou com o valor informado. */
export function planPayments(auth, budgetId, { installments, firstDueDate, amountCents, approvalId }) {
  return withTenant(auth.clinicId, async (trx) => {
    const budget = await lockBudget(trx, budgetId);
    assertReceivable(budget);
    const approval = await resolveApproval(trx, budgetId, approvalId);
    const balance = approvalTotal(approval) - (await scheduledCents(trx, approval.id));
    if (balance <= 0) throw unprocessable('Este orçamento não tem saldo a receber.', { code: 'NO_BALANCE' });

    const total = amountCents ?? balance;
    assertWithinBalance(total, balance);
    if (total < installments) throw unprocessable('O valor é menor que o número de parcelas.');

    const rows = splitAmount(total, installments).map((amount, index) => ({
      clinic_id: auth.clinicId, patient_id: budget.patient_id, budget_id: budgetId, approval_id: approval.id, amount_cents: amount,
      due_date: addMonths(firstDueDate, index), installment: index + 1, installments_total: installments, created_by: auth.userId,
    }));
    const ids = (await trx('payments').insert(rows).returning('id')).map((row) => row.id);
    for (const id of ids) await audit(trx, auth, id, 'create');
    return (await paymentsQuery(trx).whereIn('payments.id', ids).orderBy('payments.installment')).map(toPaymentDto);
  });
}

/** Lançamentos do orçamento com o resumo financeiro (total, lançado, recebido, a receber, vencido e saldo sem lançamento). */
export function listBudgetPayments(auth, budgetId) {
  return withTenant(auth.clinicId, async (trx) => {
    const budget = await findBudgetSummary(trx, budgetId);
    if (!budget) throw notFound('Orçamento');
    const rows = await paymentsQuery(trx).where('payments.budget_id', budgetId).orderBy([{ column: 'payments.due_date' }, { column: 'payments.created_at' }]);

    const active = rows.filter((row) => row.status !== 'canceled');
    const sum = (list) => list.reduce((total, row) => total + row.amount_cents, 0);
    const approvals = await listApprovals(trx, budgetId);
    const totalCents = approvals.reduce((total, approval) => total + approvalTotal(approval), 0);
    const scheduledCentsTotal = sum(active);
    return {
      summary: {
        totalCents,
        scheduledCents: scheduledCentsTotal,
        paidCents: sum(active.filter((row) => row.status === 'paid')),
        pendingCents: sum(active.filter((row) => row.status === 'pending')),
        overdueCents: sum(active.filter((row) => row.overdue)),
        balanceCents: Math.max(totalCents - scheduledCentsTotal, 0),
      },
      approvals: approvals.map((approval) => {
        const own = active.filter((row) => row.approval_id === approval.id);
        return {
          approvalId: approval.id,
          totalCents: approvalTotal(approval),
          scheduledCents: sum(own),
          paidCents: sum(own.filter((row) => row.status === 'paid')),
          balanceCents: Math.max(approvalTotal(approval) - sum(own), 0),
        };
      }),
      data: rows.map(toPaymentDto),
    };
  });
}

// ---- contas a receber ----

const applyFilters = (query, filters) =>
  query.modify((q) => {
    if (filters.status) q.where('payments.status', filters.status);
    if (filters.method) q.where('payments.method', filters.method);
    if (filters.patientId) q.where('payments.patient_id', filters.patientId);
    if (filters.budgetId) q.where('payments.budget_id', filters.budgetId);
    if (filters.dueFrom) q.where('payments.due_date', '>=', filters.dueFrom);
    if (filters.dueTo) q.where('payments.due_date', '<=', filters.dueTo);
    if (filters.overdue !== undefined) q.whereRaw("(payments.status = 'pending' AND payments.due_date < ?) = ?", [businessDate(), filters.overdue]);
  });

export function listPayments(clinicId, filters) {
  return withTenant(clinicId, async (trx) => {
    const [{ count }] = await applyFilters(trx('payments'), filters).count({ count: '*' });
    const { limit, offset } = paginate(filters);
    const rows = await applyFilters(paymentsQuery(trx), filters)
      .orderBy([{ column: 'payments.due_date' }, { column: 'payments.created_at' }, { column: 'payments.installment' }])
      .limit(limit)
      .offset(offset);
    return pageResult(rows.map(toPaymentDto), Number(count), filters);
  });
}

export function getPayment(clinicId, id) {
  return withTenant(clinicId, async (trx) => toPaymentDto(await loadPayment(trx, id)));
}

const assertPending = (payment) => {
  if (payment.status !== 'pending') throw conflict('Só é possível alterar pagamentos pendentes.', { code: 'PAYMENT_NOT_PENDING' });
};

export function updatePayment(auth, id, changes) {
  return withTenant(auth.clinicId, async (trx) => {
    const payment = await loadPayment(trx, id);
    assertPending(payment);
    if (changes.amountCents !== undefined) {
      await lockBudget(trx, payment.budget_id);
      const approval = await resolveApproval(trx, payment.budget_id, payment.approval_id);
      assertWithinBalance(changes.amountCents, approvalTotal(approval) - (await scheduledCents(trx, approval.id, id)));
    }
    await trx('payments').where({ id }).update({ ...toColumns(changes), updated_at: new Date() });
    await audit(trx, auth, id, 'update', { fields: Object.keys(changes) });
    return toPaymentDto(await findPayment(trx, id));
  });
}

/** Registra o recebimento de uma parcela pendente. */
export function payPayment(auth, id, { method, paidAt }) {
  return withTenant(auth.clinicId, async (trx) => {
    assertPending(await loadPayment(trx, id));
    await trx('payments').where({ id }).update({
      status: 'paid', method, paid_at: paidAt ? new Date(paidAt) : new Date(), received_by: auth.userId, updated_at: new Date(),
    });
    await audit(trx, auth, id, 'pay');
    return toPaymentDto(await findPayment(trx, id));
  });
}

/** Cancela uma parcela pendente; estornar um pagamento já recebido é só do administrador. */
export function cancelPayment(auth, id, { reason }) {
  return withTenant(auth.clinicId, async (trx) => {
    const payment = await loadPayment(trx, id);
    if (payment.status === 'canceled') throw conflict('Este pagamento já está cancelado.', { code: 'PAYMENT_ALREADY_CANCELED' });
    if (payment.status === 'paid' && auth.role !== 'admin') throw forbidden('Só o administrador pode estornar um pagamento já recebido.');
    await trx('payments').where({ id }).update({
      status: 'canceled', canceled_reason: reason ?? null, canceled_at: new Date(), canceled_by: auth.userId, updated_at: new Date(),
    });
    await audit(trx, auth, id, 'cancel', { from: payment.status });
    return toPaymentDto(await findPayment(trx, id));
  });
}
