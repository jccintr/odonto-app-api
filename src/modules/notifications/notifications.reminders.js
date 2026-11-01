// Lembrete automático de consulta: envia aos pacientes com atendimento dentro da janela da clínica (padrão: nas próximas 24 h).
// Pode rodar de vários lugares ao mesmo tempo (dois servidores, agendador + botão do administrador): um trava de verdade (advisory lock),
// os outros saem sem fazer nada. O banco ainda garante um único lembrete automático por atendimento.
import db from '../../db/knex.js';
import { withTenant } from '../../db/tenant.js';
import { MAX_ATTEMPTS, STALE_PENDING_MINUTES } from '../../utils/notifications.js';
import { deliverReminder, loadClinicName } from './notifications.send.js';
import { loadSettings } from './notifications.settings.js';

const LOCK_KEY = 727_001;

function candidatesQuery(trx, now, horizon) {
  return trx('appointments')
    .join('patients', 'patients.id', 'appointments.patient_id')
    .join('dentists', 'dentists.id', 'appointments.dentist_id')
    .join('users', 'users.id', 'dentists.user_id')
    .leftJoin('notifications as auto', function joinAuto() {
      this.on('auto.appointment_id', 'appointments.id').andOn(db.raw("auto.kind = 'appointment_reminder' AND auto.trigger = 'auto'"));
    })
    .whereIn('appointments.status', ['scheduled', 'confirmed'])
    .where('appointments.starts_at', '>', now)
    .where('appointments.starts_at', '<=', horizon)
    // quem já recebeu o lembrete (automático ou enviado à mão pela secretária) não recebe de novo
    .whereNotExists(trx('notifications as done').whereRaw('done.appointment_id = appointments.id').where('done.kind', 'appointment_reminder').where('done.status', 'sent'))
    .orderBy('appointments.starts_at')
    .select('appointments.*', 'patients.name as patient_name', 'patients.email as patient_email', 'patients.contact_consent', 'users.name as dentist_name',
      'auto.id as auto_id', 'auto.status as auto_status', 'auto.attempts as auto_attempts', 'auto.updated_at as auto_updated_at');
}

async function processClinic(trx, now, summary) {
  const settings = await loadSettings(trx);
  const horizon = new Date(now.getTime() + settings.reminder_hours_before * 3_600_000);
  const clinicName = await loadClinicName(trx);

  for (const appointment of await candidatesQuery(trx, now, horizon)) {
    summary.considered += 1;
    if (!appointment.patient_email) { summary.skipped.noEmail += 1; continue; }
    if (!appointment.contact_consent) { summary.skipped.noConsent += 1; continue; }

    const staleBefore = now.getTime() - STALE_PENDING_MINUTES * 60_000;
    const retryable = appointment.auto_status === 'failed' ? appointment.auto_attempts < MAX_ATTEMPTS
      : appointment.auto_status === 'pending' && appointment.auto_updated_at.getTime() < staleBefore;
    if (appointment.auto_id && !retryable) { summary.skipped.alreadyHandled += 1; continue; }

    let id = appointment.auto_id;
    if (id) {
      await trx('notifications').where({ id }).update({ status: 'pending', updated_at: new Date() });
    } else {
      [{ id }] = await trx('notifications')
        .insert({
          clinic_id: appointment.clinic_id, patient_id: appointment.patient_id, kind: 'appointment_reminder', appointment_id: appointment.id, trigger: 'auto',
          recipient: appointment.patient_email, subject: `Lembrete da sua consulta — ${clinicName}`,
        })
        .returning('id');
    }
    const ok = await deliverReminder(trx, { notificationId: id, attempts: (appointment.auto_attempts ?? 0) + 1, appointment, clinicName, settings });
    summary[ok ? 'sent' : 'failed'] += 1;
  }
}

/** Roda os lembretes (de todas as clínicas, ou só de `clinicId`). Devolve o resumo; `{ alreadyRunning: true }` se outro já está rodando. */
export function runReminders({ clinicId, now = new Date() } = {}) {
  return db.transaction(async (lock) => {
    const [{ locked }] = (await lock.raw('SELECT pg_try_advisory_xact_lock(?) AS locked', [LOCK_KEY])).rows;
    if (!locked) return { alreadyRunning: true };

    const clinics = await lock('clinics')
      .leftJoin('notification_settings', 'notification_settings.clinic_id', 'clinics.id')
      .where('clinics.status', 'active')
      .whereRaw('coalesce(notification_settings.reminders_enabled, true)')
      .modify((q) => { if (clinicId) q.where('clinics.id', clinicId); })
      .select('clinics.id');

    const summary = { alreadyRunning: false, clinics: clinics.length, considered: 0, sent: 0, failed: 0, skipped: { noEmail: 0, noConsent: 0, alreadyHandled: 0 } };
    for (const clinic of clinics) await withTenant(clinic.id, (trx) => processClinic(trx, now, summary));
    return summary;
  });
}
