// Avisos ao paciente enviados pela secretária/administração (lembrete e orçamento por e-mail) e links de WhatsApp (wa.me).
// O paciente só recebe aviso se tiver e-mail/telefone e tiver autorizado contato (contactConsent, LGPD).
import { withTenant } from '../../db/tenant.js';
import { recordAudit } from '../../services/audit.js';
import { formatDateTime, formatMoney, whatsappNumber } from '../../utils/format.js';
import { toNotificationDto } from '../../utils/dto.js';
import { conflict, notFound, unprocessable } from '../../utils/errors.js';
import { pageResult, paginate } from '../../utils/pagination.js';
import { findBudgetSummary } from '../budgets/budgets.service.js';
import { deliverBudget, deliverReminder, loadAppointment, loadClinicName } from './notifications.send.js';
import { loadSettings } from './notifications.settings.js';

const notificationsQuery = (trx) =>
  trx('notifications').join('patients', 'patients.id', 'notifications.patient_id').select('notifications.*', 'patients.name as patient_name');

const audit = (trx, auth, id, action) => recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'notification', entityId: id, action });

function assertContactable({ email, phone, consent }, channel) {
  if (channel === 'email' && !email) throw unprocessable('O paciente não tem e-mail cadastrado.', { code: 'NO_EMAIL' });
  if (channel === 'whatsapp' && !phone) throw unprocessable('O paciente não tem telefone cadastrado.', { code: 'NO_PHONE' });
  if (!consent) throw unprocessable('O paciente não autorizou o contato.', { code: 'NO_CONSENT' });
}

async function loadUpcoming(trx, appointmentId) {
  const appointment = await loadAppointment(trx, appointmentId);
  if (!appointment) throw notFound('Atendimento');
  if (!['scheduled', 'confirmed'].includes(appointment.status) || appointment.starts_at <= new Date()) {
    throw conflict('Só é possível avisar sobre atendimento futuro e ativo.', { code: 'APPOINTMENT_NOT_UPCOMING' });
  }
  return appointment;
}

/** Dados do orçamento para o aviso: paciente, itens vigentes e totais. */
async function loadBudgetForNotice(trx, budgetId) {
  const budget = await findBudgetSummary(trx, budgetId);
  if (!budget) throw notFound('Orçamento');
  const patient = await trx('patients').where({ id: budget.patient_id }).first('id', 'name', 'email', 'phone', 'contact_consent');
  const items = await trx('budget_items')
    .join('procedures', 'procedures.id', 'budget_items.procedure_id')
    .where({ 'budget_items.budget_id': budgetId })
    .where('budget_items.status', '<>', 'canceled')
    .orderBy('budget_items.position')
    .select('procedures.name', 'budget_items.tooth', 'budget_items.faces', 'budget_items.price_cents as priceCents');
  if (items.length === 0) throw unprocessable('O orçamento não tem procedimentos.', { code: 'NO_ITEMS' });
  const discountCents = budget.discount_cents;
  return { budget, patient, items, subtotalCents: budget.subtotal, discountCents, totalCents: Math.max(budget.subtotal - discountCents, 0) };
}

/** Envia agora o lembrete de um atendimento futuro. Se o e-mail falhar, o registro fica como "failed" (a resposta é igual). */
export function sendReminderNow(auth, appointmentId) {
  return withTenant(auth.clinicId, async (trx) => {
    const appointment = await loadUpcoming(trx, appointmentId);
    assertContactable({ email: appointment.patient_email, consent: appointment.contact_consent }, 'email');
    const [settings, clinicName] = [await loadSettings(trx), await loadClinicName(trx)];
    const [{ id }] = await trx('notifications')
      .insert({
        clinic_id: auth.clinicId, patient_id: appointment.patient_id, kind: 'appointment_reminder', appointment_id: appointmentId, trigger: 'manual',
        recipient: appointment.patient_email, subject: `Lembrete da sua consulta — ${clinicName}`, created_by: auth.userId,
      })
      .returning('id');
    await deliverReminder(trx, { notificationId: id, attempts: 1, appointment, clinicName, settings });
    await audit(trx, auth, id, 'create');
    return toNotificationDto(await notificationsQuery(trx).where('notifications.id', id).first());
  });
}

export function sendBudgetNow(auth, budgetId) {
  return withTenant(auth.clinicId, async (trx) => {
    const notice = await loadBudgetForNotice(trx, budgetId);
    assertContactable({ email: notice.patient.email, consent: notice.patient.contact_consent }, 'email');
    const [settings, clinicName] = [await loadSettings(trx), await loadClinicName(trx)];
    const [{ id }] = await trx('notifications')
      .insert({
        clinic_id: auth.clinicId, patient_id: notice.patient.id, kind: 'budget', budget_id: budgetId, trigger: 'manual',
        recipient: notice.patient.email, subject: `Seu orçamento — ${clinicName}`, created_by: auth.userId,
      })
      .returning('id');
    await deliverBudget(trx, { notificationId: id, patient: notice.patient, clinicName, dentistName: notice.budget.dentist_name, items: notice.items,
      subtotalCents: notice.subtotalCents, discountCents: notice.discountCents, totalCents: notice.totalCents, settings });
    await audit(trx, auth, id, 'create');
    return toNotificationDto(await notificationsQuery(trx).where('notifications.id', id).first());
  });
}

export function listNotifications(clinicId, filters) {
  const apply = (query) =>
    query.modify((q) => {
      if (filters.patientId) q.where('notifications.patient_id', filters.patientId);
      if (filters.kind) q.where('notifications.kind', filters.kind);
      if (filters.status) q.where('notifications.status', filters.status);
    });
  return withTenant(clinicId, async (trx) => {
    const [{ count }] = await apply(trx('notifications')).count({ count: '*' });
    const { limit, offset } = paginate(filters);
    const rows = await apply(notificationsQuery(trx)).orderBy([{ column: 'notifications.created_at', order: 'desc' }, { column: 'notifications.id' }]).limit(limit).offset(offset);
    return pageResult(rows.map(toNotificationDto), Number(count), filters);
  });
}

// ---- WhatsApp sem custo: link wa.me com a mensagem pronta; a secretária só confirma o envio no WhatsApp dela ----

const waLink = (phone, message) => ({ phone: whatsappNumber(phone), message, url: `https://wa.me/${whatsappNumber(phone)}?text=${encodeURIComponent(message)}` });

export function appointmentWhatsapp(clinicId, appointmentId) {
  return withTenant(clinicId, async (trx) => {
    const appointment = await loadUpcoming(trx, appointmentId);
    assertContactable({ phone: appointment.patient_phone, consent: appointment.contact_consent }, 'whatsapp');
    const clinicName = await loadClinicName(trx);
    return waLink(appointment.patient_phone,
      `Olá, ${appointment.patient_name}! Lembrete da sua consulta na ${clinicName} com ${appointment.dentist_name}: ${formatDateTime(appointment.starts_at)}. Se não puder comparecer, avise com antecedência.`);
  });
}

export function budgetWhatsapp(clinicId, budgetId) {
  return withTenant(clinicId, async (trx) => {
    const notice = await loadBudgetForNotice(trx, budgetId);
    assertContactable({ phone: notice.patient.phone, consent: notice.patient.contact_consent }, 'whatsapp');
    const clinicName = await loadClinicName(trx);
    const lines = [
      `Olá, ${notice.patient.name}! Segue o orçamento do seu tratamento com ${notice.budget.dentist_name} (${clinicName}):`,
      ...notice.items.map((item) => `- ${[item.name, item.tooth && `dente ${item.tooth}`].filter(Boolean).join(' ')}: ${formatMoney(item.priceCents)}`),
      ...(notice.discountCents > 0 ? [`Desconto: -${formatMoney(notice.discountCents)}`] : []),
      `Total: ${formatMoney(notice.totalCents)}`,
    ];
    return waLink(notice.patient.phone, lines.join('\n'));
  });
}
