import { withTenant } from '../../db/tenant.js';
import { recordAudit } from '../../services/audit.js';

export const DEFAULT_SETTINGS = { reminders_enabled: true, reminder_hours_before: 24, contact_phone: null, contact_address: null };

const COLUMN = { remindersEnabled: 'reminders_enabled', reminderHoursBefore: 'reminder_hours_before', contactPhone: 'contact_phone', contactAddress: 'contact_address' };
const toColumns = (input) => Object.fromEntries(Object.entries(input).map(([key, value]) => [COLUMN[key], value]));

/** Configuração da clínica (o RLS limita a consulta à clínica da transação); sem linha salva, valem os padrões. */
export async function loadSettings(trx) {
  return (await trx('notification_settings').first()) ?? DEFAULT_SETTINGS;
}

export const toSettingsDto = (s) => ({
  remindersEnabled: s.reminders_enabled,
  reminderHoursBefore: s.reminder_hours_before,
  contactPhone: s.contact_phone,
  contactAddress: s.contact_address,
});

export const getSettings = (clinicId) => withTenant(clinicId, async (trx) => toSettingsDto(await loadSettings(trx)));

export function updateSettings(auth, changes) {
  return withTenant(auth.clinicId, async (trx) => {
    const columns = toColumns(changes);
    const [row] = await trx('notification_settings')
      .insert({ clinic_id: auth.clinicId, ...columns })
      .onConflict('clinic_id')
      .merge({ ...columns, updated_at: new Date() })
      .returning('*');
    await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'notification_settings', entityId: auth.clinicId, action: 'update', changes: { fields: Object.keys(changes) } });
    return toSettingsDto(row);
  });
}
