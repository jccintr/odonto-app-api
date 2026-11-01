// Repasse aos dentistas: configuração da clínica, regras por exceção, lançamentos (um por procedimento realizado)
// e fechamentos pagos. Custo do procedimento (opcional) entra na base de cálculo.
import { enableTenantRls } from '../src/db/rls.js';
import { PAYMENT_METHODS } from '../src/utils/payments.js';
import { PAYOUT_RELEASE_MODES, PAYOUT_RULE_SOURCES, PAYOUT_RULE_TYPES, PAYOUT_STATUSES } from '../src/utils/payouts.js';

const quoted = (list) => list.map((v) => `'${v}'`).join(', ');
const clinicFk = (t) => t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');

export async function up(knex) {
  await knex.schema.alterTable('procedures', (t) => {
    t.integer('cost_cents').notNullable().defaultTo(0); // laboratório/material: pode ser descontado da base do repasse
  });
  await knex.raw('ALTER TABLE procedures ADD CONSTRAINT procedures_cost_check CHECK (cost_cents >= 0)');

  // ---- configuração (uma linha por clínica; sem linha = padrões) ----
  await knex.schema.createTable('payout_settings', (t) => {
    t.uuid('clinic_id').primary().references('id').inTable('clinics').onDelete('RESTRICT');
    t.string('release_on', 20).notNullable().defaultTo('payment');
    t.boolean('deduct_costs').notNullable().defaultTo(false);
    t.boolean('deduct_card_fees').notNullable().defaultTo(false);
    t.decimal('credit_card_fee_percent', 5, 2).notNullable().defaultTo(0);
    t.decimal('debit_card_fee_percent', 5, 2).notNullable().defaultTo(0);
    t.decimal('default_percent', 5, 2).notNullable().defaultTo(0);
    t.timestamps(true, true);
  });
  await knex.raw(`ALTER TABLE payout_settings ADD CONSTRAINT payout_settings_release_check CHECK (release_on IN (${quoted(PAYOUT_RELEASE_MODES)}))`);
  await knex.raw(`ALTER TABLE payout_settings ADD CONSTRAINT payout_settings_percent_check CHECK (
    credit_card_fee_percent BETWEEN 0 AND 100 AND debit_card_fee_percent BETWEEN 0 AND 100 AND default_percent BETWEEN 0 AND 100)`);
  await enableTenantRls(knex, 'payout_settings');

  // ---- regras por exceção: procedimento (e, opcionalmente, um dentista específico) ----
  await knex.schema.createTable('payout_rules', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    clinicFk(t);
    t.uuid('procedure_id').notNullable();
    t.uuid('dentist_id');
    t.string('type', 10).notNullable();
    t.decimal('percent', 5, 2);
    t.integer('fixed_cents');
    t.timestamps(true, true);
    t.foreign(['clinic_id', 'procedure_id']).references(['clinic_id', 'id']).inTable('procedures').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'dentist_id']).references(['clinic_id', 'id']).inTable('dentists').onDelete('RESTRICT');
  });
  await knex.raw(`ALTER TABLE payout_rules ADD CONSTRAINT payout_rules_type_check CHECK (
    (type = 'percent' AND percent BETWEEN 0 AND 100 AND fixed_cents IS NULL) OR (type = 'fixed' AND fixed_cents >= 0 AND percent IS NULL))`);
  await knex.raw(`ALTER TABLE payout_rules ADD CONSTRAINT payout_rules_type_values CHECK (type IN (${quoted(PAYOUT_RULE_TYPES)}))`);
  await knex.raw('CREATE UNIQUE INDEX payout_rules_procedure_unique ON payout_rules (clinic_id, procedure_id) WHERE dentist_id IS NULL');
  await knex.raw('CREATE UNIQUE INDEX payout_rules_dentist_procedure_unique ON payout_rules (clinic_id, procedure_id, dentist_id) WHERE dentist_id IS NOT NULL');
  await enableTenantRls(knex, 'payout_rules');

  // ---- lançamentos: um por procedimento realizado, com a regra congelada no momento da execução ----
  await knex.schema.createTable('payout_entries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    clinicFk(t);
    t.uuid('budget_id').notNullable();
    t.uuid('item_id').notNullable().unique();
    t.uuid('patient_id').notNullable();
    t.uuid('dentist_id').notNullable();
    t.timestamp('performed_at', { useTz: true }).notNullable();
    t.integer('gross_cents').notNullable();
    t.integer('cost_cents').notNullable();
    t.integer('base_cents').notNullable();
    t.string('rule_source', 20).notNullable();
    t.string('rule_type', 10).notNullable();
    t.decimal('rule_percent', 5, 2);
    t.integer('rule_fixed_cents');
    t.integer('commission_cents').notNullable();
    t.jsonb('terms').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['clinic_id', 'id']);
    t.index(['clinic_id', 'dentist_id', 'performed_at']);
    t.foreign(['clinic_id', 'budget_id']).references(['clinic_id', 'id']).inTable('budgets').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'item_id']).references(['clinic_id', 'id']).inTable('budget_items').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'patient_id']).references(['clinic_id', 'id']).inTable('patients').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'dentist_id']).references(['clinic_id', 'id']).inTable('dentists').onDelete('RESTRICT');
  });
  await knex.raw(`ALTER TABLE payout_entries ADD CONSTRAINT payout_entries_source_check CHECK (rule_source IN (${quoted(PAYOUT_RULE_SOURCES)}))`);
  await knex.raw(`ALTER TABLE payout_entries ADD CONSTRAINT payout_entries_amounts_check CHECK (gross_cents >= 0 AND cost_cents >= 0 AND base_cents >= 0 AND commission_cents >= 0)`);
  await enableTenantRls(knex, 'payout_entries', { grants: 'SELECT, INSERT' }); // lançamento nunca muda nem some

  // ---- fechamentos pagos ao dentista ----
  await knex.schema.createTable('payouts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    clinicFk(t);
    t.uuid('dentist_id').notNullable();
    t.date('until').notNullable();
    t.integer('total_cents').notNullable();
    t.string('method', 20).notNullable();
    t.timestamp('paid_at', { useTz: true }).notNullable();
    t.uuid('paid_by');
    t.text('notes');
    t.string('status', 20).notNullable().defaultTo('paid');
    t.string('canceled_reason', 240);
    t.timestamp('canceled_at', { useTz: true });
    t.uuid('canceled_by');
    t.timestamps(true, true);
    t.unique(['clinic_id', 'id']);
    t.index(['clinic_id', 'dentist_id', 'paid_at']);
    t.foreign(['clinic_id', 'dentist_id']).references(['clinic_id', 'id']).inTable('dentists').onDelete('RESTRICT');
  });
  await knex.raw('ALTER TABLE payouts ADD CONSTRAINT payouts_total_check CHECK (total_cents > 0)');
  await knex.raw(`ALTER TABLE payouts ADD CONSTRAINT payouts_status_check CHECK (status IN (${quoted(PAYOUT_STATUSES)}))`);
  await knex.raw(`ALTER TABLE payouts ADD CONSTRAINT payouts_method_check CHECK (method IN (${quoted(PAYMENT_METHODS)}))`);
  await enableTenantRls(knex, 'payouts', { grants: 'SELECT, INSERT, UPDATE' });

  await knex.schema.createTable('payout_lines', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    clinicFk(t);
    t.uuid('payout_id').notNullable();
    t.uuid('entry_id').notNullable();
    t.integer('amount_cents').notNullable(); // negativo = desconto de estorno de pagamento já repassado
    t.index(['clinic_id', 'entry_id']);
    t.foreign(['clinic_id', 'payout_id']).references(['clinic_id', 'id']).inTable('payouts').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'entry_id']).references(['clinic_id', 'id']).inTable('payout_entries').onDelete('RESTRICT');
  });
  await knex.raw('ALTER TABLE payout_lines ADD CONSTRAINT payout_lines_amount_check CHECK (amount_cents <> 0)');
  await enableTenantRls(knex, 'payout_lines', { grants: 'SELECT, INSERT' });
}

export async function down(knex) {
  for (const table of ['payout_lines', 'payouts', 'payout_entries', 'payout_rules', 'payout_settings']) {
    await knex.schema.dropTableIfExists(table);
  }
  await knex.raw('ALTER TABLE procedures DROP CONSTRAINT IF EXISTS procedures_cost_check');
  await knex.schema.alterTable('procedures', (t) => t.dropColumn('cost_cents'));
}
