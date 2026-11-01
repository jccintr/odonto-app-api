// Envio de um aviso: registra, envia e atualiza o resultado. O registro nasce ANTES do envio, então nada some se o servidor cair.
import { sendAppointmentReminderEmail, sendBudgetEmail } from '../../services/mailer.js';
import { formatDateTime } from '../../utils/format.js';

/** Dados do atendimento e do paciente usados no lembrete e nas regras de envio. */
export const loadAppointment = (trx, appointmentId) =>
  trx('appointments')
    .join('patients', 'patients.id', 'appointments.patient_id')
    .join('dentists', 'dentists.id', 'appointments.dentist_id')
    .join('users', 'users.id', 'dentists.user_id')
    .where('appointments.id', appointmentId)
    .first('appointments.*', 'patients.name as patient_name', 'patients.email as patient_email', 'patients.phone as patient_phone',
      'patients.contact_consent', 'users.name as dentist_name');

export const loadClinicName = async (trx) => (await trx('clinics').first('name')).name;

/** Marca o resultado do envio. Falha não lança: fica registrada para nova tentativa e para a secretária ver. */
async function finish(trx, id, attempts, send) {
  try {
    const result = await send();
    if (result?.skipped) throw new Error('SMTP não configurado');
    await trx('notifications').where({ id }).update({ status: 'sent', attempts, sent_at: new Date(), last_error: null, updated_at: new Date() });
    return true;
  } catch (err) {
    await trx('notifications').where({ id }).update({ status: 'failed', attempts, last_error: String(err.message).slice(0, 300), updated_at: new Date() });
    return false;
  }
}

export function deliverReminder(trx, { notificationId, attempts, appointment, clinicName, settings }) {
  return finish(trx, notificationId, attempts, () =>
    sendAppointmentReminderEmail({
      to: appointment.patient_email, patientName: appointment.patient_name, clinicName, dentistName: appointment.dentist_name,
      when: formatDateTime(appointment.starts_at), address: settings.contact_address, phone: settings.contact_phone,
    }));
}

export function deliverBudget(trx, { notificationId, patient, clinicName, dentistName, items, subtotalCents, discountCents, totalCents, settings }) {
  return finish(trx, notificationId, 1, () =>
    sendBudgetEmail({ to: patient.email, patientName: patient.name, clinicName, dentistName, items, subtotalCents, discountCents, totalCents, phone: settings.contact_phone }));
}
