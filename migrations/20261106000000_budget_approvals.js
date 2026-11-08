// Rodadas de aprovação: cada vez que o paciente aprova procedimentos do orçamento nasce uma rodada, com desconto e parcelas próprios.
// Itens sem rodada estão "propostos" (ainda não aprovados); só os aprovados podem ser executados e cobrados.
import { enableTenantRls } from '../src/db/rls.js';

export async function up(knex) {
  await knex.schema.createTable('budget_approvals', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');
    t.uuid('budget_id').notNullable();
    t.integer('discount_cents').notNullable().defaultTo(0);
    t.string('notes', 500);
    t.uuid('approved_by');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['clinic_id', 'budget_id']);
    t.unique(['clinic_id', 'id']);
    t.foreign(['clinic_id', 'budget_id']).references(['clinic_id', 'id']).inTable('budgets').onDelete('RESTRICT');
  });
  await knex.raw('ALTER TABLE budget_approvals ADD CONSTRAINT budget_approvals_discount_check CHECK (discount_cents >= 0)');
  await enableTenantRls(knex, 'budget_approvals', { grants: 'SELECT, INSERT' });

  await knex.raw('ALTER TABLE budget_items ADD COLUMN approval_id uuid');
  await knex.raw('ALTER TABLE budget_items ADD CONSTRAINT budget_items_approval_fk FOREIGN KEY (clinic_id, approval_id) REFERENCES budget_approvals (clinic_id, id) ON DELETE RESTRICT');
  await knex.raw('ALTER TABLE payments ADD COLUMN approval_id uuid');
  await knex.raw('ALTER TABLE payments ADD CONSTRAINT payments_approval_fk FOREIGN KEY (clinic_id, approval_id) REFERENCES budget_approvals (clinic_id, id) ON DELETE RESTRICT');

  // orçamentos que já estavam aprovados viram uma única rodada, com o desconto que tinham
  await knex.raw(`
    INSERT INTO budget_approvals (clinic_id, budget_id, discount_cents, approved_by, created_at)
    SELECT clinic_id, id, discount_cents, created_by, coalesce(approved_at, created_at)
    FROM budgets WHERE status IN ('approved', 'completed')`);
  await knex.raw(`
    UPDATE budget_items SET approval_id = a.id
    FROM budget_approvals a WHERE a.budget_id = budget_items.budget_id AND a.clinic_id = budget_items.clinic_id`);
  await knex.raw(`
    UPDATE payments SET approval_id = a.id
    FROM budget_approvals a WHERE a.budget_id = payments.budget_id AND a.clinic_id = payments.clinic_id`);
}

export async function down(knex) {
  await knex.raw('ALTER TABLE payments DROP COLUMN approval_id');
  await knex.raw('ALTER TABLE budget_items DROP COLUMN approval_id');
  await knex.schema.dropTableIfExists('budget_approvals');
}
