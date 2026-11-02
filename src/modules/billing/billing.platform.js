// Cobrança vista pelo dono da plataforma: confirmar Pix, estender teste, cortesia e planos. Usa o pool "dono" (sem RLS), sempre filtrando pela clínica.
import db from '../../db/knex.js';
import { addDays, addMonths, businessDate } from '../../utils/dates.js';
import { conflict, notFound } from '../../utils/errors.js';
import { toInvoiceDto, toPlanDto } from '../../utils/dto.js';
import { escapeLike, pageResult, paginate } from '../../utils/pagination.js';
import { nextPeriodStart } from './access.js';
import { buildView, loadSubscription, logEvent } from './billing.service.js';
import { pixFor } from './pix.js';

const actor = (admin) => `platform:${admin.id}`;

async function requireSubscription(trx, clinicId) {
  const sub = await loadSubscription(trx, clinicId);
  if (!sub) throw notFound('Clínica');
  return sub;
}

export async function getClinicBilling(clinicId) {
  const sub = await requireSubscription(db, clinicId);
  const [view, events] = await Promise.all([
    buildView(db, sub, businessDate()),
    db('billing_events').where({ clinic_id: clinicId }).orderBy('created_at', 'desc').limit(30),
  ]);
  return {
    ...view,
    events: events.map((e) => ({ type: e.type, actor: e.actor, data: e.data, createdAt: e.created_at })),
  };
}

/** Fila de faturas para o dono conferir: por padrão, as abertas; `reported=true` mostra só as que a clínica disse ter pago. */
export async function listInvoices({ status = 'OPEN', reported, q, ...paging }) {
  const filtered = () =>
    db('invoices')
      .join('clinics', 'clinics.id', 'invoices.clinic_id')
      .where('invoices.status', status)
      .modify((query) => {
        if (reported) query.whereNotNull('invoices.reported_paid_at');
        if (q) query.whereILike('clinics.name', `%${escapeLike(q)}%`);
      });
  const [{ count }] = await filtered().count({ count: '*' });
  const { limit, offset } = paginate(paging);
  const rows = await filtered()
    .select('invoices.*', 'clinics.name as clinic_name')
    .orderByRaw('invoices.reported_paid_at DESC NULLS LAST, invoices.due_on ASC')
    .limit(limit)
    .offset(offset);
  return pageResult(rows.map((row) => ({ ...toInvoiceDto(row, row.status === 'OPEN' ? pixFor(row) : null), clinicName: row.clinic_name })), Number(count), paging);
}

/** Confirma o Pix: o período pago começa depois da cobertura atual (ou hoje, se já venceu) e dura 1 mês. */
export async function markInvoicePaid(admin, clinicId, invoiceId, note) {
  await db.transaction(async (trx) => {
    const sub = await trx('subscriptions').where({ clinic_id: clinicId }).forUpdate().first();
    if (!sub) throw notFound('Clínica');
    const invoice = await trx('invoices').where({ id: invoiceId, clinic_id: clinicId }).first();
    if (!invoice) throw notFound('Fatura');
    if (invoice.status !== 'OPEN') throw conflict('Esta fatura não está em aberto.', { code: 'INVOICE_NOT_OPEN' });

    const start = nextPeriodStart(sub, businessDate());
    const end = addDays(addMonths(start, 1), -1);
    const now = new Date();
    await trx('invoices').where({ id: invoiceId }).update({
      status: 'PAID', paid_at: now, paid_by_admin_id: admin.id, payment_note: note ?? null, period_start: start, period_end: end,
    });
    await trx('subscriptions').where({ id: sub.id }).update({ paid_until: end, updated_at: now });
    const plan = await trx('plans').where({ id: invoice.plan_id }).first('code');
    await trx('clinics').where({ id: clinicId }).update({ plan: plan.code, updated_at: now });
    await logEvent(trx, clinicId, 'invoice_paid', { invoiceId, paidUntil: end, note: note ?? null }, actor(admin));
  });
  return getClinicBilling(clinicId);
}

/** Soma dias ao teste, a partir do fim dele (ou de hoje, se já acabou). */
export async function extendTrial(admin, clinicId, days) {
  await db.transaction(async (trx) => {
    const sub = await trx('subscriptions').where({ clinic_id: clinicId }).forUpdate().first();
    if (!sub) throw notFound('Clínica');
    const base = sub.trial_ends_on > businessDate() ? sub.trial_ends_on : businessDate();
    const trialEndsOn = addDays(base, days);
    await trx('subscriptions').where({ id: sub.id }).update({ trial_ends_on: trialEndsOn, updated_at: new Date() });
    await logEvent(trx, clinicId, 'trial_extended', { days, trialEndsOn }, actor(admin));
  });
  return getClinicBilling(clinicId);
}

/** Cortesia (uso grátis): por tempo indeterminado, até uma data, ou remove (until null e indefinite false). */
export async function setCourtesy(admin, clinicId, { until, indefinite }) {
  await db.transaction(async (trx) => {
    const sub = await trx('subscriptions').where({ clinic_id: clinicId }).forUpdate().first();
    if (!sub) throw notFound('Clínica');
    await trx('subscriptions').where({ id: sub.id }).update({
      courtesy_indefinite: indefinite, courtesy_until: indefinite ? null : until, updated_at: new Date(),
    });
    await logEvent(trx, clinicId, 'courtesy_set', { until: indefinite ? null : until, indefinite }, actor(admin));
  });
  return getClinicBilling(clinicId);
}

// ---- planos ----

export async function listPlans() {
  return (await db('plans').orderBy('position')).map(toPlanDto);
}

export async function updatePlan(id, changes) {
  const columns = {
    ...(changes.name !== undefined && { name: changes.name }),
    ...(changes.description !== undefined && { description: changes.description }),
    ...(changes.priceCents !== undefined && { price_cents: changes.priceCents }),
    ...(changes.maxDentists !== undefined && { max_dentists: changes.maxDentists }),
    ...(changes.active !== undefined && { active: changes.active }),
    ...(changes.position !== undefined && { position: changes.position }),
  };
  const [plan] = await db('plans').where({ id }).update({ ...columns, updated_at: new Date() }).returning('*');
  if (!plan) throw notFound('Plano');
  return toPlanDto(plan);
}
