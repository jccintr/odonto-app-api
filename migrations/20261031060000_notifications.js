// Avisos ao paciente (lembrete de consulta e orçamento por e-mail). Cada envio fica registrado.
import { enableTenantRls } from '../src/db/rls.js';
import { NOTIFICATION_KINDS, NOTIFICATION_STATUSES, NOTIFICATION_TRIGGERS } from '../src/utils/notifications.js';

const quoted = (list) => list.map((v) => `'${v}'`).join(', ');

export async function up(knex) {
  await knex.raw('ALTER TABLE appointments ADD CONSTRAINT appointments_clinic_id_id_unique UNIQUE (clinic_id, id)');

  await knex.schema.createTable('notification_settings', (t) => {
    t.uuid('clinic_id').primary().references('id').inTable('clinics').onDelete('RESTRICT');
    t.boolean('reminders_enabled').notNullable().defaultTo(true);
    t.specificType('reminder_hours_before', 'smallint').notNullable().defaultTo(24);
    t.string('contact_phone', 20);
    t.string('contact_address', 240);
    t.timestamps(true, true);
  });
  await knex.raw('ALTER TABLE notification_settings ADD CONSTRAINT notification_settings_hours_check CHECK (reminder_hours_before BETWEEN 1 AND 72)');
  await enableTenantRls(knex, 'notification_settings');

  await knex.schema.createTable('notifications', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');
    t.uuid('patient_id').notNullable();
    t.string('kind', 30).notNullable();
    t.string('channel', 10).notNullable().defaultTo('email');
    t.uuid('appointment_id');
    t.uuid('budget_id');
    t.string('trigger', 10).notNullable();
    t.string('recipient', 254).notNullable();
    t.string('subject', 200).notNullable();
    t.string('status', 10).notNullable().defaultTo('pending');
    t.specificType('attempts', 'smallint').notNullable().defaultTo(0);
    t.string('last_error', 300);
    t.timestamp('sent_at', { useTz: true });
    t.uuid('created_by');
    t.timestamps(true, true);
    t.index(['clinic_id', 'created_at']);
    t.index(['clinic_id', 'patient_id']);
    t.foreign(['clinic_id', 'patient_id']).references(['clinic_id', 'id']).inTable('patients').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'appointment_id']).references(['clinic_id', 'id']).inTable('appointments').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'budget_id']).references(['clinic_id', 'id']).inTable('budgets').onDelete('RESTRICT');
  });
  await knex.raw(`ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (${quoted(NOTIFICATION_KINDS)}))`);
  await knex.raw(`ALTER TABLE notifications ADD CONSTRAINT notifications_status_check CHECK (status IN (${quoted(NOTIFICATION_STATUSES)}))`);
  await knex.raw(`ALTER TABLE notifications ADD CONSTRAINT notifications_trigger_check CHECK (trigger IN (${quoted(NOTIFICATION_TRIGGERS)}))`);
  await knex.raw(`ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check CHECK (channel = 'email')`);
  await knex.raw(`ALTER TABLE notifications ADD CONSTRAINT notifications_ref_check CHECK (
    (kind = 'appointment_reminder' AND appointment_id IS NOT NULL AND budget_id IS NULL) OR (kind = 'budget' AND budget_id IS NOT NULL AND appointment_id IS NULL))`);
  // o lembrete AUTOMÁTICO de um atendimento nasce uma única vez (o banco garante, mesmo com dois servidores rodando)
  await knex.raw("CREATE UNIQUE INDEX notifications_auto_reminder_unique ON notifications (appointment_id) WHERE kind = 'appointment_reminder' AND trigger = 'auto'");
  await enableTenantRls(knex, 'notifications', { grants: 'SELECT, INSERT, UPDATE' });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('notifications');
  await knex.schema.dropTableIfExists('notification_settings');
  await knex.raw('ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_clinic_id_id_unique');
}
