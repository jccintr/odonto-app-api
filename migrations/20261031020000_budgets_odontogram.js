// Orçamentos, itens do orçamento (procedimento por dente/face) e odontograma do paciente.
import { enableTenantRls } from '../src/db/rls.js';
import { CONDITIONS, TEETH } from '../src/utils/tooth.js';

const uuidPk = (knex, t) => t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
const clinicFk = (t) => t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');
const quoted = (list) => list.map((v) => `'${v}'`).join(', ');

export async function up(knex) {
  // ao realizar o procedimento, esta condição é marcada automaticamente no dente do orçamento
  await knex.raw('ALTER TABLE procedures ADD COLUMN odontogram_condition varchar(30)');
  await knex.raw(`ALTER TABLE procedures ADD CONSTRAINT procedures_condition_check CHECK (odontogram_condition IS NULL OR odontogram_condition IN (${quoted(CONDITIONS)}))`);

  // ---- orçamentos ----
  await knex.schema.createTable('budgets', (t) => {
    uuidPk(knex, t);
    clinicFk(t);
    t.uuid('patient_id').notNullable();
    t.uuid('dentist_id').notNullable();
    t.string('status', 20).notNullable().defaultTo('open');
    t.integer('discount_cents').notNullable().defaultTo(0);
    t.text('notes');
    t.timestamp('approved_at', { useTz: true });
    t.uuid('created_by');
    t.timestamps(true, true);
    t.unique(['clinic_id', 'id']);
    t.index(['clinic_id', 'patient_id']);
    t.foreign(['clinic_id', 'patient_id']).references(['clinic_id', 'id']).inTable('patients').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'dentist_id']).references(['clinic_id', 'id']).inTable('dentists').onDelete('RESTRICT');
  });
  await knex.raw(`ALTER TABLE budgets ADD CONSTRAINT budgets_status_check CHECK (status IN ('open', 'approved', 'rejected', 'completed'))`);
  await knex.raw('ALTER TABLE budgets ADD CONSTRAINT budgets_discount_check CHECK (discount_cents >= 0)');
  await enableTenantRls(knex, 'budgets');

  await knex.schema.createTable('budget_items', (t) => {
    uuidPk(knex, t);
    clinicFk(t);
    t.uuid('budget_id').notNullable();
    t.uuid('procedure_id').notNullable();
    t.specificType('tooth', 'smallint');
    t.string('faces', 5);
    t.integer('price_cents').notNullable();
    t.integer('position').notNullable().defaultTo(0); // ordem dos itens dentro do orçamento
    t.string('status', 20).notNullable().defaultTo('pending');
    t.uuid('performed_by_dentist_id'); // quem executou (base do repasse)
    t.timestamp('performed_at', { useTz: true });
    t.timestamps(true, true);
    t.unique(['clinic_id', 'id']);
    t.index(['clinic_id', 'budget_id']);
    t.foreign(['clinic_id', 'budget_id']).references(['clinic_id', 'id']).inTable('budgets').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'procedure_id']).references(['clinic_id', 'id']).inTable('procedures').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'performed_by_dentist_id']).references(['clinic_id', 'id']).inTable('dentists').onDelete('RESTRICT');
  });
  await knex.raw(`ALTER TABLE budget_items ADD CONSTRAINT budget_items_status_check CHECK (status IN ('pending', 'done', 'canceled'))`);
  await knex.raw('ALTER TABLE budget_items ADD CONSTRAINT budget_items_price_check CHECK (price_cents >= 0)');
  await knex.raw(`ALTER TABLE budget_items ADD CONSTRAINT budget_items_tooth_check CHECK (tooth IS NULL OR tooth IN (${TEETH.join(', ')}))`);
  await knex.raw(`ALTER TABLE budget_items ADD CONSTRAINT budget_items_faces_check CHECK (faces IS NULL OR faces ~ '^[VLMDO]{1,5}$')`);
  await knex.raw('ALTER TABLE budget_items ADD CONSTRAINT budget_items_faces_tooth_check CHECK (faces IS NULL OR tooth IS NOT NULL)');
  await knex.raw(`ALTER TABLE budget_items ADD CONSTRAINT budget_items_done_check CHECK (status <> 'done' OR (performed_at IS NOT NULL AND performed_by_dentist_id IS NOT NULL))`);
  await enableTenantRls(knex, 'budget_items');

  // ---- odontograma: histórico de marcações por dente (nada é apagado de verdade, só marcado como removido) ----
  await knex.schema.createTable('tooth_records', (t) => {
    uuidPk(knex, t);
    clinicFk(t);
    t.uuid('patient_id').notNullable();
    t.specificType('tooth', 'smallint').notNullable();
    t.string('faces', 5);
    t.string('condition', 30).notNullable();
    t.text('notes');
    t.uuid('source_item_id'); // marcação criada ao realizar um item do orçamento
    t.date('recorded_on').notNullable().defaultTo(knex.raw('CURRENT_DATE'));
    t.uuid('recorded_by').notNullable();
    t.timestamp('removed_at', { useTz: true });
    t.uuid('removed_by');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['clinic_id', 'patient_id', 'tooth']);
    t.foreign(['clinic_id', 'patient_id']).references(['clinic_id', 'id']).inTable('patients').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'source_item_id']).references(['clinic_id', 'id']).inTable('budget_items').onDelete('RESTRICT');
  });
  await knex.raw(`ALTER TABLE tooth_records ADD CONSTRAINT tooth_records_tooth_check CHECK (tooth IN (${TEETH.join(', ')}))`);
  await knex.raw(`ALTER TABLE tooth_records ADD CONSTRAINT tooth_records_faces_check CHECK (faces IS NULL OR faces ~ '^[VLMDO]{1,5}$')`);
  await knex.raw(`ALTER TABLE tooth_records ADD CONSTRAINT tooth_records_condition_check CHECK (condition IN (${quoted(CONDITIONS)}))`);
  await enableTenantRls(knex, 'tooth_records', { grants: 'SELECT, INSERT, UPDATE' });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('tooth_records');
  await knex.schema.dropTableIfExists('budget_items');
  await knex.schema.dropTableIfExists('budgets');
  await knex.raw('ALTER TABLE procedures DROP COLUMN IF EXISTS odontogram_condition');
}
