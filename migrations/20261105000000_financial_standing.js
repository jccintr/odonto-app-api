// Adimplência: tolerância de atraso da clínica, liberações do bloqueio (só o administrador) e o início do atendimento.
import { enableTenantRls } from '../src/db/rls.js';

export async function up(knex) {
  // dias de atraso que a clínica tolera antes de bloquear o paciente (padrão: uma semana)
  await knex.raw('ALTER TABLE clinics ADD COLUMN overdue_grace_days smallint NOT NULL DEFAULT 7');
  await knex.raw('ALTER TABLE clinics ADD CONSTRAINT clinics_overdue_grace_check CHECK (overdue_grace_days BETWEEN 0 AND 60)');

  // o dentista inicia o atendimento antes de concluí-lo: é nesse momento que a adimplência é conferida
  await knex.raw('ALTER TABLE appointments ADD COLUMN started_at timestamptz');
  await knex.raw('ALTER TABLE appointments DROP CONSTRAINT appointments_status_check');
  await knex.raw(`ALTER TABLE appointments ADD CONSTRAINT appointments_status_check CHECK (status IN ('scheduled', 'confirmed', 'in_progress', 'attended', 'no_show', 'canceled'))`);

  // exceção dada pelo administrador (urgência, dor): vale até a data informada, com motivo; nada é editado nem apagado
  await knex.schema.createTable('block_releases', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');
    t.uuid('patient_id').notNullable();
    t.string('reason', 240).notNullable();
    t.timestamp('valid_until', { useTz: true }).notNullable();
    t.uuid('released_by').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['clinic_id', 'patient_id', 'valid_until']);
    t.foreign(['clinic_id', 'patient_id']).references(['clinic_id', 'id']).inTable('patients').onDelete('RESTRICT');
  });
  await enableTenantRls(knex, 'block_releases', { grants: 'SELECT, INSERT' });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('block_releases');
  await knex.raw('ALTER TABLE appointments DROP CONSTRAINT appointments_status_check');
  await knex.raw(`ALTER TABLE appointments ADD CONSTRAINT appointments_status_check CHECK (status IN ('scheduled', 'confirmed', 'attended', 'no_show', 'canceled'))`);
  await knex.raw('ALTER TABLE appointments DROP COLUMN started_at');
  await knex.raw('ALTER TABLE clinics DROP COLUMN overdue_grace_days');
}
