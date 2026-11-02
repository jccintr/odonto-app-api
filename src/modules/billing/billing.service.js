// Assinatura da clínica: situação, escolha do plano, faturas e aviso de pagamento ("Já paguei").
// Pagamento manual por Pix, como no Delivroo: o dono da plataforma confere o Pix e confirma a fatura (billing.platform.js).
import { config } from '../../config/env.js';
import { withTenant } from '../../db/tenant.js';
import { addDays, addMonths, businessDate, daysBetween } from '../../utils/dates.js';
import { conflict, notFound, unprocessable } from '../../utils/errors.js';
import { toInvoiceDto, toPlanDto } from '../../utils/dto.js';
import { computeAccess, coveredUntil, nextPeriodStart } from './access.js';
import { notifyOwner } from './notify.js';
import { pixFor } from './pix.js';

export const loadSubscription = (db, clinicId) => db('subscriptions').where({ clinic_id: clinicId }).first();

export const logEvent = (db, clinicId, type, data, actor) =>
  db('billing_events').insert({ clinic_id: clinicId, type, data: JSON.stringify(data), actor });

/**
 * Cria a fatura do próximo período, se o plano já foi escolhido e não há fatura aberta.
 * Sem `force`, só nasce quando faltam `INVOICE_LEAD_DAYS` ou menos para acabar a cobertura (ou já acabou).
 */
export async function ensureInvoice(db, sub, today, { force = false } = {}) {
  if (!sub.plan_id || sub.courtesy_indefinite) return;
  if (!force && daysBetween(today, coveredUntil(sub)) > config.invoiceLeadDays) return;
  const plan = await db('plans').where({ id: sub.plan_id }).first();
  const start = nextPeriodStart(sub, today);
  await db('invoices')
    .insert({
      clinic_id: sub.clinic_id, subscription_id: sub.id, plan_id: plan.id, amount_cents: plan.price_cents,
      period_start: start, period_end: addDays(addMonths(start, 1), -1), due_on: start > today ? start : today,
    })
    .onConflict(db.raw("(subscription_id) WHERE status = 'OPEN'"))
    .ignore(); // duas telas abertas ao mesmo tempo não criam duas faturas
}

/** A tela de assinatura inteira: situação, plano, planos à venda, fatura aberta (com Pix) e as últimas pagas. */
export async function buildView(db, sub, today) {
  const access = computeAccess(sub, today);
  const [plan, plans, open, paid] = await Promise.all([
    sub.plan_id ? db('plans').where({ id: sub.plan_id }).first() : null,
    db('plans').where({ active: true }).orderBy('position'),
    db('invoices').where({ subscription_id: sub.id, status: 'OPEN' }).first(),
    db('invoices').where({ subscription_id: sub.id, status: 'PAID' }).orderBy('paid_at', 'desc').limit(12),
  ]);
  return {
    ...access,
    trialEndsOn: sub.trial_ends_on,
    paidUntil: sub.paid_until,
    courtesyUntil: sub.courtesy_until,
    courtesyIndefinite: sub.courtesy_indefinite,
    deletionRequestedAt: sub.deletion_requested_at,
    plan: plan ? toPlanDto(plan) : null,
    plans: plans.map(toPlanDto),
    invoice: open ? toInvoiceDto(open, pixFor(open)) : null,
    invoices: paid.map((invoice) => toInvoiceDto(invoice)),
    pixConfigured: Boolean(config.billingPixKey),
  };
}

/** Situação resumida (qualquer perfil enxerga: o aviso de teste e de atraso aparece para todos). */
export function getStatus(clinicId) {
  return withTenant(clinicId, async (trx) => {
    const sub = await loadSubscription(trx, clinicId);
    const plan = sub.plan_id ? await trx('plans').where({ id: sub.plan_id }).first('name') : null;
    return { ...computeAccess(sub, businessDate()), planName: plan?.name ?? null };
  });
}

export function getBilling(clinicId) {
  return withTenant(clinicId, async (trx) => {
    const today = businessDate();
    const sub = await loadSubscription(trx, clinicId);
    await ensureInvoice(trx, sub, today);
    return buildView(trx, sub, today);
  });
}

export async function choosePlan(clinicId, userId, planId) {
  return withTenant(clinicId, async (trx) => {
    const today = businessDate();
    const plan = await trx('plans').where({ id: planId, active: true }).first();
    if (!plan) throw notFound('Plano');
    const sub = await loadSubscription(trx, clinicId);

    if (plan.max_dentists !== null) {
      const [{ count }] = await trx('users').where({ role: 'dentist', active: true }).count({ count: '*' });
      if (Number(count) > plan.max_dentists) {
        throw unprocessable(`A clínica tem ${count} dentistas ativos e o plano ${plan.name} permite até ${plan.max_dentists}. Desative dentistas ou escolha outro plano.`, { code: 'PLAN_LIMIT' });
      }
    }
    const open = await trx('invoices').where({ subscription_id: sub.id, status: 'OPEN' }).first();
    if (open?.reported_paid_at) {
      throw conflict('Há um pagamento aguardando confirmação. Espere a confirmação antes de trocar de plano.', { code: 'PAYMENT_PENDING' });
    }
    if (open) await trx('invoices').where({ id: open.id }).update({ status: 'VOID' });

    const changed = { ...sub, plan_id: plan.id };
    await trx('subscriptions').where({ id: sub.id }).update({ plan_id: plan.id, updated_at: new Date() });
    await ensureInvoice(trx, changed, today, { force: true });
    await logEvent(trx, clinicId, 'plan_chosen', { planId: plan.id, plan: plan.code }, `clinic:${userId}`);
    return buildView(trx, changed, today);
  });
}

/** A clínica avisa que pagou. Só sinaliza: quem confirma é o dono da plataforma. */
export async function reportPaid(clinicId, userId, invoiceId, note) {
  const { view, clinicName, invoice } = await withTenant(clinicId, async (trx) => {
    const invoice = await trx('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw notFound('Fatura');
    if (invoice.status !== 'OPEN') throw conflict('Esta fatura não está em aberto.', { code: 'INVOICE_NOT_OPEN' });
    if (invoice.reported_paid_at) throw conflict('Você já avisou este pagamento. Aguarde a confirmação.', { code: 'ALREADY_REPORTED' });
    await trx('invoices').where({ id: invoiceId }).update({ reported_paid_at: new Date(), reported_note: note ?? null });
    await logEvent(trx, clinicId, 'payment_reported', { invoiceId, note: note ?? null }, `clinic:${userId}`);
    const { name } = await trx('clinics').first('name');
    const sub = await loadSubscription(trx, clinicId);
    return { view: await buildView(trx, sub, businessDate()), clinicName: name, invoice };
  });
  await notifyOwner('Pagamento informado', [
    `A clínica "${clinicName}" avisou que pagou a fatura de R$ ${(invoice.amount_cents / 100).toFixed(2).replace('.', ',')}.`,
    note ? `Observação: ${note}` : '',
    'Confira o Pix e confirme a fatura no painel da plataforma.',
  ].filter(Boolean));
  return view;
}
