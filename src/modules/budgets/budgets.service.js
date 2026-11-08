import { withTenant } from '../../db/tenant.js';
import { assertActiveDentist, ownDentistId } from '../../services/dentistScope.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../utils/errors.js';
import { toBudgetDto, toBudgetSummaryDto } from '../../utils/dto.js';
import { businessDate } from '../../utils/dates.js';
import { pageResult, paginate } from '../../utils/pagination.js';
import { recordAudit } from '../../services/audit.js';
import { recordExecution } from '../payouts/payouts.accrual.js';

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

/** Rodadas de aprovação do orçamento, com o valor de cada uma (itens não cancelados menos o desconto da rodada). */
export async function listApprovals(trx, budgetId) {
  const rows = await trx('budget_approvals')
    .leftJoin('budget_items', function join() { this.on('budget_items.approval_id', 'budget_approvals.id').andOnVal('budget_items.status', '<>', 'canceled'); })
    .where('budget_approvals.budget_id', budgetId)
    .groupBy('budget_approvals.id')
    .orderBy('budget_approvals.created_at')
    .select('budget_approvals.*', trx.raw('coalesce(sum(budget_items.price_cents), 0)::int AS subtotal'), trx.raw('count(budget_items.id)::int AS items_count'));
  return rows;
}

async function detail(trx, auth, id) {
  const row = await loadBudget(trx, auth, id);
  const items = await trx('budget_items')
    .join('procedures', 'procedures.id', 'budget_items.procedure_id')
    .where('budget_items.budget_id', id)
    .select('budget_items.*', 'procedures.name as procedure_name')
    .orderBy('budget_items.position');
  return toBudgetDto(row, items, await listApprovals(trx, id));
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
// itens podem ser incluídos, alterados e removidos enquanto estão só propostos: com o orçamento em aberto ou já em tratamento
const assertEditable = (budget) => {
  if (!['open', 'approved'].includes(budget.status)) throw conflict('Só é possível alterar orçamentos em aberto ou em tratamento.', { code: 'BUDGET_NOT_OPEN' });
};
const assertProposed = (item) => {
  if (item.approval_id) throw conflict('Este procedimento já foi aprovado pelo paciente.', { code: 'ITEM_ALREADY_APPROVED' });
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
    if (status === 'approved') {
      if (budget.items_count === 0) throw unprocessable('Inclua ao menos um procedimento para aprovar.');
      // aprovar o orçamento inteiro = uma rodada com todos os itens e o desconto combinado no orçamento
      const ids = (await trx('budget_items').where({ budget_id: id, status: 'pending' }).whereNull('approval_id').select('id')).map((row) => row.id);
      await createApproval(trx, auth, budget, { itemIds: ids, discountCents: budget.discount_cents });
    } else {
      await trx('budgets').where({ id }).update({ status, approved_at: null, updated_at: new Date() });
    }
    return detail(trx, auth, id);
  });
}

// ---- rodadas de aprovação ----

// o desconto do orçamento passa a ser a soma dos descontos das rodadas (relatórios e repasses continuam lendo daqui)
async function syncBudgetDiscount(trx, budgetId) {
  const [{ sum }] = await trx('budget_approvals').where({ budget_id: budgetId }).sum({ sum: 'discount_cents' });
  await trx('budgets').where({ id: budgetId }).update({ discount_cents: Number(sum) });
}

async function createApproval(trx, auth, budget, { itemIds, discountCents, notes }) {
  const items = await trx('budget_items').where({ budget_id: budget.id }).whereIn('id', itemIds).select('id', 'status', 'approval_id', 'price_cents');
  if (items.length !== new Set(itemIds).size) throw notFound('Item do orçamento');
  if (items.some((item) => item.status !== 'pending')) throw conflict('Só procedimentos pendentes podem ser aprovados.', { code: 'ITEM_NOT_PENDING' });
  if (items.some((item) => item.approval_id)) throw conflict('Este procedimento já foi aprovado pelo paciente.', { code: 'ITEM_ALREADY_APPROVED' });
  assertDiscount(items.reduce((sum, item) => sum + item.price_cents, 0), discountCents);

  const [{ id }] = await trx('budget_approvals')
    .insert({ clinic_id: auth.clinicId, budget_id: budget.id, discount_cents: discountCents, notes: notes ?? null, approved_by: auth.userId })
    .returning('id');
  await trx('budget_items').whereIn('id', itemIds).update({ approval_id: id, updated_at: new Date() });
  await syncBudgetDiscount(trx, budget.id);
  await trx('budgets').where({ id: budget.id }).update({ status: 'approved', approved_at: budget.approved_at ?? new Date(), updated_at: new Date() });
  await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'budget_approval', entityId: id, action: 'create', changes: { budgetId: budget.id, items: itemIds.length, discountCents } });
  return id;
}

/** O paciente aprovou alguns procedimentos (agora ou depois): nasce uma rodada com desconto próprio, sem mexer nas anteriores. */
export function approveItems(auth, id, input) {
  return withTenant(auth.clinicId, async (trx) => {
    const budget = await loadBudget(trx, auth, id);
    assertEditable(budget);
    await createApproval(trx, auth, budget, input);
    return detail(trx, auth, id);
  });
}

// ---- itens (enquanto propostos, com o orçamento em aberto ou em tratamento) ----

export function addItem(auth, id, input) {
  return withTenant(auth.clinicId, async (trx) => {
    assertEditable(await loadBudget(trx, auth, id));
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
    assertEditable(budget);
    const item = await loadItem(trx, id, itemId);
    assertProposed(item);

    const next = { tooth: item.tooth, faces: item.faces, price_cents: item.price_cents, ...toColumns(changes) };
    if (next.faces && !next.tooth) throw unprocessable('Informe o dente para indicar as faces.');
    if (budget.status === 'open') assertDiscount(budget.subtotal - item.price_cents + next.price_cents, budget.discount_cents);

    await trx('budget_items').where({ id: itemId }).update({ ...next, updated_at: new Date() });
    return detail(trx, auth, id);
  });
}

export function removeItem(auth, id, itemId) {
  return withTenant(auth.clinicId, async (trx) => {
    const budget = await loadBudget(trx, auth, id);
    assertEditable(budget);
    const item = await loadItem(trx, id, itemId);
    assertProposed(item);
    if (budget.status === 'open') assertDiscount(budget.subtotal - item.price_cents, budget.discount_cents);
    await trx('budget_items').where({ id: itemId }).del();
    if (budget.status === 'approved') await completeIfFinished(trx, id);
    return detail(trx, auth, id);
  });
}

// ---- execução (orçamento aprovado) ----

// dá baixa no item: guarda quem executou, marca o dente no odontograma e gera o repasse
async function executeItem(trx, auth, { budget, item, performer, when }) {
  await trx('budget_items').where({ id: item.id }).update({
    status: 'done', performed_by_dentist_id: performer, performed_at: when, updated_at: new Date(),
  });
  if (item.tooth && item.odontogram_condition) {
    await trx('tooth_records').insert({
      clinic_id: auth.clinicId, patient_id: budget.patient_id, tooth: item.tooth, faces: item.faces,
      condition: item.odontogram_condition, source_item_id: item.id, recorded_by: auth.userId, recorded_on: businessDate(when),
    });
  }
  // o repasse segue o desconto da rodada em que o item foi aprovado, não o das outras
  const [round] = await trx('budget_items')
    .join('budget_approvals', 'budget_approvals.id', 'budget_items.approval_id')
    .leftJoin(trx('budget_items as peers').where('peers.status', '<>', 'canceled').groupBy('peers.approval_id').select('peers.approval_id').sum({ subtotal: 'peers.price_cents' }).as('totals'), 'totals.approval_id', 'budget_approvals.id')
    .where('budget_items.id', item.id)
    .select('budget_approvals.discount_cents', trx.raw('coalesce(totals.subtotal, 0)::int AS subtotal'));
  await recordExecution(trx, { auth, budget: { ...budget, subtotal: round.subtotal, discount_cents: round.discount_cents }, item, dentistId: performer, performedAt: when });
  await completeIfFinished(trx, budget.id);
}

/**
 * Dá baixa em itens de orçamentos aprovados do paciente durante o atendimento (usado pela evolução clínica).
 * Devolve os itens executados, com procedimento, dente e faces, para entrarem no registro.
 */
export async function performItemsDuringAppointment(trx, auth, { patientId, items, dentistId }) {
  const done = [];
  const when = new Date();
  for (const { itemId, teeth, wholeMouth } of items) {
    const found = await trx('budget_items')
      .join('budgets', 'budgets.id', 'budget_items.budget_id')
      .join('procedures', 'procedures.id', 'budget_items.procedure_id')
      .where({ 'budget_items.id': itemId, 'budgets.patient_id': patientId })
      .first('budget_items.*', 'budgets.id as budget_ref', 'procedures.odontogram_condition', 'procedures.name as procedure_name');
    if (!found) throw notFound('Item do orçamento');
    // o dente do item vale; se o item não tem dente, o dentista diz onde foi feito
    if (found.tooth && (teeth || wholeMouth)) throw unprocessable('Este item do orçamento já tem dente definido.');
    if (!found.tooth && !teeth && !wholeMouth) throw unprocessable(`Informe os dentes afetados em "${found.procedure_name}" ou marque boca toda.`, { code: 'TEETH_REQUIRED' });
    // qualquer dentista da clínica executa o que o paciente aprovou, mesmo em orçamento de outro dentista (sem filtro de carteira)
    const budget = await findBudgetSummary(trx, found.budget_ref);
    assertApproved(budget);
    if (found.status !== 'pending') throw conflict('Este procedimento já foi finalizado.', { code: 'ITEM_NOT_PENDING' });
    if (!found.approval_id) throw conflict('O paciente ainda não aprovou este procedimento.', { code: 'ITEM_NOT_APPROVED' });
    await executeItem(trx, auth, { budget, item: found, performer: dentistId, when });
    const base = { procedureId: found.procedure_id, procedureName: found.procedure_name, faces: found.faces, budgetItemId: found.id };
    if (found.tooth) done.push({ ...base, tooth: found.tooth, wholeMouth: false });
    else if (wholeMouth) done.push({ ...base, tooth: null, wholeMouth: true });
    else for (const tooth of teeth) done.push({ ...base, tooth, wholeMouth: false });
  }
  return done;
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
