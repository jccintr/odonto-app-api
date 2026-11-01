// Pagamentos dos pacientes: cada linha é uma parcela a receber (pendente), um recebimento (pago) ou um cancelamento.
import { enableTenantRls } from '../src/db/rls.js';
import { PAYMENT_METHODS, PAYMENT_STATUSES } from '../src/utils/payments.js';

const quoted = (list) => list.map((v) => `'${v}'`).join(', ');

export async function up(knex) {
  await knex.schema.createTable('payments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');
    t.uuid('patient_id').notNullable();
    t.uuid('budget_id').notNullable();
    t.integer('amount_cents').notNullable();
    t.date('due_date').notNullable();
    t.string('status', 20).notNullable().defaultTo('pending');
    t.string('method', 20);
    t.timestamp('paid_at', { useTz: true });
    t.uuid('received_by');
    t.specificType('installment', 'smallint');
    t.specificType('installments_total', 'smallint');
    t.string('canceled_reason', 240);
    t.timestamp('canceled_at', { useTz: true });
    t.uuid('canceled_by');
    t.text('notes');
    t.uuid('created_by');
    t.timestamps(true, true);
    t.index(['clinic_id', 'status', 'due_date']);
    t.index(['clinic_id', 'budget_id']);
    t.foreign(['clinic_id', 'patient_id']).references(['clinic_id', 'id']).inTable('patients').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'budget_id']).references(['clinic_id', 'id']).inTable('budgets').onDelete('RESTRICT');
  });
  await knex.raw('ALTER TABLE payments ADD CONSTRAINT payments_amount_check CHECK (amount_cents > 0)');
  await knex.raw(`ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (status IN (${quoted(PAYMENT_STATUSES)}))`);
  await knex.raw(`ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IS NULL OR method IN (${quoted(PAYMENT_METHODS)}))`);
  await knex.raw(`ALTER TABLE payments ADD CONSTRAINT payments_paid_check CHECK (status <> 'paid' OR (method IS NOT NULL AND paid_at IS NOT NULL))`);
  await knex.raw('ALTER TABLE payments ADD CONSTRAINT payments_installment_check CHECK (installment IS NULL OR (installment >= 1 AND installments_total >= installment))');
  await enableTenantRls(knex, 'payments');
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('payments');
}
