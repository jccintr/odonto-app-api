// Prontuário: evolução clínica de cada atendimento realizado. Só acrescenta (a aplicação não altera nem apaga):
// erro se corrige com uma retificação (kind 'addendum'), que fica ligada ao registro original.
import { enableTenantRls } from '../src/db/rls.js';

export async function up(knex) {
  await knex.schema.createTable('evolutions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');
    t.uuid('patient_id').notNullable();
    t.uuid('dentist_id').notNullable();
    t.uuid('appointment_id');
    t.uuid('parent_id');
    t.string('kind', 10).notNullable();
    t.text('description');
    t.uuid('created_by').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['clinic_id', 'id']);
    t.index(['clinic_id', 'patient_id', 'created_at']);
    t.foreign(['clinic_id', 'patient_id']).references(['clinic_id', 'id']).inTable('patients').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'dentist_id']).references(['clinic_id', 'id']).inTable('dentists').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'appointment_id']).references(['clinic_id', 'id']).inTable('appointments').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'parent_id']).references(['clinic_id', 'id']).inTable('evolutions').onDelete('RESTRICT');
  });
  await knex.raw(`ALTER TABLE evolutions ADD CONSTRAINT evolutions_kind_check CHECK (
    (kind = 'evolution' AND appointment_id IS NOT NULL AND parent_id IS NULL) OR
    (kind = 'addendum' AND parent_id IS NOT NULL AND appointment_id IS NULL AND description IS NOT NULL))`);
  await knex.raw(`CREATE UNIQUE INDEX evolutions_one_per_appointment ON evolutions (appointment_id) WHERE kind = 'evolution'`);
  await enableTenantRls(knex, 'evolutions', { grants: 'SELECT, INSERT' });

  await knex.schema.createTable('evolution_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');
    t.uuid('evolution_id').notNullable();
    t.uuid('procedure_id').notNullable();
    t.string('procedure_name', 160).notNullable(); // o nome como estava na hora (o prontuário não muda se a tabela de preços mudar)
    t.specificType('tooth', 'smallint');
    t.string('faces', 5);
    t.uuid('budget_item_id');
    t.index('evolution_id');
    t.foreign(['clinic_id', 'evolution_id']).references(['clinic_id', 'id']).inTable('evolutions').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'procedure_id']).references(['clinic_id', 'id']).inTable('procedures').onDelete('RESTRICT');
  });
  await enableTenantRls(knex, 'evolution_items', { grants: 'SELECT, INSERT' });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('evolution_items');
  await knex.schema.dropTableIfExists('evolutions');
}
