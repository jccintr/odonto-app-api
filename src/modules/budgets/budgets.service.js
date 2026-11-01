import { withTenant } from '../../db/tenant.js';
import { assertActiveDentist, ownDentistId } from '../../services/dentistScope.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../utils/errors.js';
import { toBudgetDto, toBudgetSummaryDto } from '../../utils/dto.js';
import { businessDate } from '../../utils/dates.js';
import { pageResult, paginate } from '../../utils/pagination.js';

// "completed" não é escolhido por ninguém: acontece sozinho quando não resta item pendente
const TRANSITIONS = { open: ['approved', 'rejected'], rejected: ['open'], approved: [], completed: [] };
const COLUMN = { discountCents: 'discount_cents', priceCents: 'price_cents' };
const toColumns = (input) => Object.fromEntries(Object.entries(input).map(([key, value]) => [COLUMN[key] ?? key, value]));

// ---- consultas ----

// subtotal e quantidade consideram só os itens não cancelados
function summaryQuery(trx) {
  const totals = trx('budget_items')
    .where('status', '<>', 'canceled')
    .groupBy('budget_id')
    .select('budget_id', trx.raw('sum(price_cents)::int AS subtotal'), trx.raw('count(*)::int AS items_count'));
  return trx('budgets')
    .join('patients', 'patients.id', 'budgets.patient_id')
    .join('dentists', 'dentists.id', 'budgets.dentist_id')
    .join('users', 'users.id', 'dentists.user_id')
    .leftJoin(totals.as('totals'), 'totals.budget_id', 'budgets.id')
    .select(
      'budgets.*', 'patients.name as patient_name', 'users.name as dentist_name',
      trx.raw('coalesce(totals.subtotal, 0)::int AS subtotal'), trx.raw('coalesce(totals.items_count, 0)::int AS items_count'),
    );
}

const applyFilters = (query, filters, scope) =>
  query.modify((q) => {
    const dentistId = scope ?? filters.dentistId;
    if (dentistId) q.where('budgets.dentist_id', dentistId);
    if (filters.patientId) q.where('budgets.patient_id', filters.patientId);
    if (filters.status) q.where('budgets.status', filters.status);
  });

/** Resumo do orçamento (com subtotal) sem filtro de escopo: usado pelos pagamentos, que são da administração. */
export const findBudgetSummary = (trx, id) => summaryQuery(trx).where('budgets.id', id).first();

/** Carrega o orçamento respeitando o escopo: o dentista só alcança os dele. */
async function loadBudget(trx, auth, id) {
  const scope = await ownDentistId(trx, auth);
  const row = await summaryQuery(trx)
    .where('budgets.id', id)
    .modify((q) => { if (scope) q.where('budgets.dentist_id', scope); })
    .first();
  if (!row) throw notFound('Orçamento');
  return row;
}

async function detail(trx, auth, id) {
  const row = await loadBudget(trx, auth, id);
  const items = await trx('budget_items')
    .join('procedures', 'procedures.id', 'budget_items.procedure_id')
    .where('budget_items.budget_id', id)
    .select('budget_items.*', 'procedures.name as procedure_name')
    .orderBy('budget_items.position');
  return toBudgetDto(row, items);
}

async function loadItem(trx, budgetId, itemId) {
  const item = await trx('budget_items')
    .join('procedures', 'procedures.id', 'budget_items.procedure_id')
    .where({ 'budget_items.id': itemId, 'budget_items.budget_id': budgetId })
    .first('budget_items.*', 'procedures.odontogram_condition');
  if (!item) throw notFound('Item do orçamento');
  return item;
}

// ---- regras ----

const assertOpen = (budget) => {
  if (budget.status !== 'open') throw conflict('Só é possível alterar orçamentos em aberto.', { code: 'BUDGET_NOT_OPEN' });
};
const assertApproved = (budget) => {
  if (budget.status !== 'approved') throw conflict('O orçamento precisa estar aprovado para executar este passo.', { code: 'BUDGET_NOT_APPROVED' });
};
const assertDiscount = (subtotal, discount) => {
  if (discount > subtotal) throw unprocessable('O desconto não pode ser maior que o valor do orçamento.');
};

async function loadProcedures(trx, ids) {
  const unique = [...new Set(ids)];
  const rows = await trx('procedures').whereIn('id', unique).select('id', 'name', 'price_cents', 'active');
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of unique) {
    const procedure = byId.get(id);
    if (!procedure) throw notFound('Procedimento');
    if (!procedure.active) throw unprocessable(`O procedimento "${procedure.name}" está desativado.`);
  }
  return byId;
}

async function completeIfFinished(trx, budgetId) {
  const [{ count }] = await trx('budget_items').where({ budget_id: budgetId, status: 'pending' }).count({ count: '*' });
  if (Number(count) === 0) await trx('budgets').where({ id: budgetId }).update({ status: 'completed', updated_at: new Date() });
}

// ---- orçamentos ----

export function listBudgets(auth, filters) {
  return withTenant(auth.clinicId, async (trx) => {
    const scope = await ownDentistId(trx, auth);
    const [{ count }] = await applyFilters(trx('budgets'), filters, scope).count({ count: '*' });
    const { limit, offset } = paginate(filters);
    const rows = await applyFilters(summaryQuery(trx), filters, scope).orderBy('budgets.created_at', 'desc').limit(limit).offset(offset);
    return pageResult(rows.map(toBudgetSummaryDto), Number(count), filters);
  });
}

export function getBudget(auth, id) {
  return withTenant(auth.clinicId, (trx) => detail(trx, auth, id));
}

export function createBudget(auth, input) {
  return withTenant(auth.clinicId, async (trx) => {
    const own = await ownDentistId(trx, auth);
    if (own && input.dentistId && input.dentistId !== own) throw forbidden('O dentista só cria orçamentos na própria carteira.');
    const dentistId = own ?? input.dentistId;
    if (!dentistId) throw badRequest('Informe o dentista.');

    const patient = await trx('patients').where({ id: input.patientId }).first('active');
    if (!patient) throw notFound('Paciente');
    if (!patient.active) throw unprocessable('Este paciente está arquivado.');
    await assertActiveDentist(trx, dentistId);

    const procedures = await loadProcedures(trx, input.items.map((item) => item.procedureId));
    const items = input.items.map((item, index) => ({
      clinic_id: auth.clinicId,
      procedure_id: item.procedureId,
      tooth: item.tooth,
      faces: item.faces,
      price_cents: item.priceCents ?? procedures.get(item.procedureId).price_cents,
      position: index + 1,
    }));
    assertDiscount(items.reduce((sum, item) => sum + item.price_cents, 0), input.discountCents);

    const [{ id }] = await trx('budgets')
      .insert({
        clinic_id: auth.clinicId, patient_id: input.patientId, dentist_id: dentistId,
        discount_cents: input.discountCents, notes: input.notes, created_by: auth.userId,
      })
      .returning('id');
    await trx('budget_items').insert(items.map((item) => ({ ...item, budget_id: id })));
    return detail(trx, auth, id);
  });
}

export function updateBudget(auth, id, changes) {
  return withTenant(auth.clinicId, async (trx) => {
    const budget = await loadBudget(trx, auth, id);
    assertOpen(budget);
    assertDiscount(budget.subtotal, changes.discountCents ?? budget.discount_cents);
    await trx('budgets').where({ id }).update({ ...toColumns(changes), updated_at: new Date() });
    return detail(trx, auth, id);
  });
}

export function changeStatus(auth, id, { status }) {
  return withTenant(auth.clinicId, async (trx) => {
    const budget = await loadBudget(trx, auth, id);
    if (!TRANSITIONS[budget.status].includes(status)) {
      throw conflict(`Não é possível mudar de "${budget.status}" para "${status}".`, { code: 'INVALID_TRANSITION' });
    }
    if (status === 'approved' && budget.items_count === 0) throw unprocessable('Inclua ao menos um procedimento para aprovar.');
    await trx('budgets').where({ id }).update({ status, approved_at: status === 'approved' ? new Date() : null, updated_at: new Date() });
    return detail(trx, auth, id);
  });
}

// ---- itens (só enquanto o orçamento está em aberto) ----

export function addItem(auth, id, input) {
  return withTenant(auth.clinicId, async (trx) => {
    assertOpen(await loadBudget(trx, auth, id));
    const procedure = (await loadProcedures(trx, [input.procedureId])).get(input.procedureId);
    const [{ max }] = await trx('budget_items').where({ budget_id: id }).max({ max: 'position' });
    await trx('budget_items').insert({
      clinic_id: auth.clinicId, budget_id: id, procedure_id: input.procedureId, tooth: input.tooth, faces: input.faces,
      price_cents: input.priceCents ?? procedure.price_cents, position: (max ?? 0) + 1,
    });
    return detail(trx, auth, id);
  });
}

export function updateItem(auth, id, itemId, changes) {
  return withTenant(auth.clinicId, async (trx) => {
    const budget = await loadBudget(trx, auth, id);
    assertOpen(budget);
    const item = await loadItem(trx, id, itemId);

    const next = { tooth: item.tooth, faces: item.faces, price_cents: item.price_cents, ...toColumns(changes) };
    if (next.faces && !next.tooth) throw unprocessable('Informe o dente para indicar as faces.');
    assertDiscount(budget.subtotal - item.price_cents + next.price_cents, budget.discount_cents);

    await trx('budget_items').where({ id: itemId }).update({ ...next, updated_at: new Date() });
    return detail(trx, auth, id);
  });
}

export function removeItem(auth, id, itemId) {
  return withTenant(auth.clinicId, async (trx) => {
    const budget = await loadBudget(trx, auth, id);
    assertOpen(budget);
    const item = await loadItem(trx, id, itemId);
    assertDiscount(budget.subtotal - item.price_cents, budget.discount_cents);
    await trx('budget_items').where({ id: itemId }).del();
    return detail(trx, auth, id);
  });
}

// ---- execução (orçamento aprovado) ----

/**
 * Registra que o procedimento foi realizado: guarda quem executou (base do repasse) e, se o procedimento
 * tem condição de odontograma e o item tem dente, marca o dente do paciente automaticamente.
 */
export function performItem(auth, id, itemId, { dentistId, performedAt }) {
  return withTenant(auth.clinicId, async (trx) => {
    const budget = await loadBudget(trx, auth, id);
    assertApproved(budget);
    const item = await loadItem(trx, id, itemId);
    if (item.status !== 'pending') throw conflict('Este procedimento já foi finalizado.', { code: 'ITEM_NOT_PENDING' });

    const own = await ownDentistId(trx, auth);
    if (own && dentistId && dentistId !== own) throw forbidden('O dentista só registra procedimentos executados por ele.');
    const performer = own ?? dentistId ?? budget.dentist_id;
    await assertActiveDentist(trx, performer);

    const when = performedAt ? new Date(performedAt) : new Date();
    await trx('budget_items').where({ id: itemId }).update({
      status: 'done', performed_by_dentist_id: performer, performed_at: when, updated_at: new Date(),
    });
    if (item.tooth && item.odontogram_condition) {
      await trx('tooth_records').insert({
        clinic_id: auth.clinicId, patient_id: budget.patient_id, tooth: item.tooth, faces: item.faces,
        condition: item.odontogram_condition, source_item_id: item.id, recorded_by: auth.userId, recorded_on: businessDate(when),
      });
    }
    await completeIfFinished(trx, id);
    return detail(trx, auth, id);
  });
}

/** O paciente desistiu de um procedimento já aprovado. */
export function cancelItem(auth, id, itemId) {
  return withTenant(auth.clinicId, async (trx) => {
    assertApproved(await loadBudget(trx, auth, id));
    const item = await loadItem(trx, id, itemId);
    if (item.status !== 'pending') throw conflict('Este procedimento já foi finalizado.', { code: 'ITEM_NOT_PENDING' });
    await trx('budget_items').where({ id: itemId }).update({ status: 'canceled', updated_at: new Date() });
    await completeIfFinished(trx, id);
    return detail(trx, auth, id);
  });
}
