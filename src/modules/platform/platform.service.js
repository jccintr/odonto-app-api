import db from '../../db/knex.js';
import { conflict, notFound, tooManyRequests, unauthorized } from '../../utils/errors.js';
import { toClinicDto, toPlatformAdminDto } from '../../utils/dto.js';
import { escapeLike, pageResult, paginate } from '../../utils/pagination.js';
import { loginThrottle } from '../../utils/loginThrottle.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../../services/password.js';
import { signPlatformToken } from '../../services/tokens.js';
import { provisionClinic } from '../clinic/provision.js';
import { BILLING_STATES, computeAccess } from '../billing/access.js';
import { businessDate } from '../../utils/dates.js';

// ---- administradores da plataforma ----

export async function createPlatformAdmin({ name, email, password }) {
  try {
    const [admin] = await db('platform_admins')
      .insert({ name, email: email.trim().toLowerCase(), password_hash: await hashPassword(password) })
      .returning('*');
    return toPlatformAdminDto(admin);
  } catch (err) {
    if (err.code === '23505') throw conflict('E-mail já cadastrado.');
    throw err;
  }
}

export async function platformLogin({ email, password, ip }) {
  const key = `platform|${ip}|${email}`;
  const wait = loginThrottle.blockedFor(key);
  if (wait > 0) throw tooManyRequests('Muitas tentativas de login. Tente novamente mais tarde.', wait);

  const admin = await db('platform_admins').where({ email }).first();
  const passwordOk = await verifyPassword(password, admin ? admin.password_hash : DUMMY_HASH);
  if (!admin || !passwordOk || !admin.active) {
    loginThrottle.fail(key);
    throw unauthorized('E-mail ou senha inválidos.');
  }
  loginThrottle.reset(key);
  return { token: signPlatformToken(admin), admin: toPlatformAdminDto(admin) };
}

// ---- clínicas ----

/** Cria a clínica e o primeiro administrador, na mesma transação. O e-mail de verificação sai depois do commit. */
export async function createClinic(input) {
  const { clinic, admin } = await provisionClinic(input);
  return { clinic, admin };
}

// Situação da assinatura de cada clínica, calculada das datas (mesma regra do painel da clínica).
const SUBSCRIPTION_COLUMNS = [
  'subscriptions.trial_ends_on', 'subscriptions.paid_until', 'subscriptions.courtesy_until', 'subscriptions.courtesy_indefinite',
  'subscriptions.deletion_requested_at', 'plans.name as plan_name', 'plans.price_cents as plan_price_cents',
];
const withSubscription = (query) =>
  query.join('subscriptions', 'subscriptions.clinic_id', 'clinics.id').leftJoin('plans', 'plans.id', 'subscriptions.plan_id');

const toPlatformClinicDto = (row, today) => ({
  ...toClinicDto(row),
  subscription: {
    ...computeAccess(row, today),
    planName: row.plan_name,
    deletionRequestedAt: row.deletion_requested_at,
    templateCode: row.template_code,
  },
});

export async function listClinics({ status, billing, q, ...paging }) {
  const filtered = () =>
    db('clinics').modify((query) => {
      if (status) query.where('clinics.status', status);
      if (q) query.where((b) => b.whereILike('clinics.name', `%${escapeLike(q)}%`).orWhereILike('clinics.slug', `%${escapeLike(q)}%`));
    });
  const today = businessDate();
  const rowsQuery = () => withSubscription(filtered()).select('clinics.*', ...SUBSCRIPTION_COLUMNS).orderBy('clinics.name');

  if (billing) {
    // a situação da assinatura é calculada em código (não existe coluna para filtrar no SQL): filtra e pagina em memória
    const dtos = (await rowsQuery()).map((row) => toPlatformClinicDto(row, today)).filter((c) => c.subscription.state === billing);
    const { limit, offset } = paginate(paging);
    return pageResult(dtos.slice(offset, offset + limit), dtos.length, paging);
  }
  const [{ count }] = await filtered().count({ count: '*' });
  const { limit, offset } = paginate(paging);
  const rows = await rowsQuery().limit(limit).offset(offset);
  return pageResult(rows.map((row) => toPlatformClinicDto(row, today)), Number(count), paging);
}

export async function getClinic(id) {
  const row = await withSubscription(db('clinics').where('clinics.id', id)).first('clinics.*', ...SUBSCRIPTION_COLUMNS);
  if (!row) throw notFound('Clínica');
  return toPlatformClinicDto(row, businessDate());
}

/** Números para a tela inicial do backoffice. */
export async function overview() {
  const today = businessDate();
  const rows = await withSubscription(db('clinics')).select('clinics.id', 'clinics.status', 'clinics.created_at', ...SUBSCRIPTION_COLUMNS);
  const byState = Object.fromEntries(BILLING_STATES.map((state) => [state, 0]));
  let mrrCents = 0;
  let deletionRequests = 0;
  let newLast7Days = 0;
  let newLast30Days = 0;
  const day = 86_400_000;
  for (const row of rows) {
    const { state } = computeAccess(row, today);
    byState[state] += 1;
    // receita mensal recorrente: clínicas com plano pago em dia ou em carência
    if ((state === 'active' || state === 'past_due') && row.plan_price_cents) mrrCents += row.plan_price_cents;
    if (row.deletion_requested_at) deletionRequests += 1;
    const age = Date.now() - new Date(row.created_at).getTime();
    if (age <= 7 * day) newLast7Days += 1;
    if (age <= 30 * day) newLast30Days += 1;
  }
  const [open] = await db('invoices').where({ status: 'OPEN' }).select(
    db.raw('count(*)::int AS open'),
    db.raw('count(*) FILTER (WHERE reported_paid_at IS NOT NULL)::int AS awaiting'),
    db.raw('coalesce(sum(amount_cents) FILTER (WHERE reported_paid_at IS NOT NULL), 0)::int AS awaiting_cents'),
  );
  return {
    clinics: { total: rows.length, suspendedManually: rows.filter((r) => r.status === 'suspended').length, byState },
    mrrCents,
    awaitingConfirmation: { count: open.awaiting, amountCents: open.awaiting_cents },
    openInvoices: open.open,
    deletionRequests,
    newLast7Days,
    newLast30Days,
  };
}

export async function updateClinic(id, changes) {
  const [clinic] = await db('clinics').where({ id }).update({ ...changes, updated_at: new Date() }).returning('*');
  if (!clinic) throw notFound('Clínica');
  return toClinicDto(clinic);
}
