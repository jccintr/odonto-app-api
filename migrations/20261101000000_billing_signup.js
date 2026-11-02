// Cadastro público de clínicas e assinatura da plataforma: planos, assinatura (1 por clínica), faturas (Pix manual),
// histórico de cobrança e aceite dos termos (LGPD). Datas de cobrança são DATE (dias, fuso de Brasília), não instantes.
// O acesso da clínica é CALCULADO dessas datas na hora da leitura (src/modules/billing/access.js): nenhum cron suspende ninguém.
import { enableTenantRls, APP_ROLE } from '../src/db/rls.js';

const uuidPk = (knex, t) => t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
const clinicFk = (t) => t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');
const TRIAL_DAYS = 14;
const TODAY_BR = "(timezone('America/Sao_Paulo', now()))::date";

export async function up(knex) {
  // ---- planos (tabela da plataforma, igual para todas as clínicas) ----
  await knex.schema.createTable('plans', (t) => {
    uuidPk(knex, t);
    t.string('code', 30).notNullable().unique();
    t.string('name', 80).notNullable();
    t.string('description', 255);
    t.integer('price_cents').notNullable(); // preço MENSAL; a fatura guarda uma cópia do valor
    t.integer('max_dentists'); // null = sem limite
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true); // plano desativado não aparece para novas escolhas, mas quem já tem continua
    t.timestamps(true, true);
  });
  await knex.raw('ALTER TABLE plans ADD CONSTRAINT plans_price_check CHECK (price_cents > 0)');
  await knex.raw(`GRANT SELECT ON plans TO ${APP_ROLE}`);
  await knex('plans').insert([
    { code: 'essencial', name: 'Essencial', description: 'Para o consultório com 1 dentista.', price_cents: 7900, max_dentists: 1, position: 1 },
    { code: 'clinica', name: 'Clínica', description: 'Para clínicas com até 4 dentistas.', price_cents: 14900, max_dentists: 4, position: 2 },
    { code: 'premium', name: 'Premium', description: 'Dentistas ilimitados, para clínicas maiores.', price_cents: 24900, max_dentists: null, position: 3 },
  ]);

  // ---- origem do cadastro e lembrete de revisar os preços do modelo ----
  await knex.schema.alterTable('clinics', (t) => {
    t.string('template_code', 30); // modelo escolhido no cadastro (null = clínica criada pela plataforma)
    t.timestamp('prices_reviewed_at', { useTz: true }); // a clínica conferiu os preços de exemplo do modelo
  });

  // ---- assinatura: 1 por clínica ----
  await knex.schema.createTable('subscriptions', (t) => {
    uuidPk(knex, t);
    t.uuid('clinic_id').notNullable().unique().references('id').inTable('clinics').onDelete('RESTRICT');
    t.uuid('plan_id').references('id').inTable('plans'); // null = ainda não escolheu (período de teste)
    t.date('trial_ends_on').notNullable(); // último dia do teste (inclusive)
    t.date('paid_until'); // último dia já pago (inclusive)
    t.date('courtesy_until'); // cortesia (grátis) até este dia
    t.boolean('courtesy_indefinite').notNullable().defaultTo(false);
    t.timestamp('deletion_requested_at', { useTz: true }); // pedido de exclusão dos dados (LGPD)
    t.timestamps(true, true);
  });
  await enableTenantRls(knex, 'subscriptions', { grants: 'SELECT, UPDATE' });

  await knex.schema.createTable('invoices', (t) => {
    uuidPk(knex, t);
    clinicFk(t);
    t.uuid('subscription_id').notNullable().references('id').inTable('subscriptions').onDelete('RESTRICT');
    t.uuid('plan_id').notNullable().references('id').inTable('plans');
    t.integer('amount_cents').notNullable(); // cópia do preço do plano no momento da fatura
    t.date('period_start').notNullable();
    t.date('period_end').notNullable();
    t.date('due_on').notNullable(); // pagar até este dia para não interromper o serviço
    t.string('status', 10).notNullable().defaultTo('OPEN');
    t.timestamp('reported_paid_at', { useTz: true }); // a clínica clicou em "Já paguei"
    t.string('reported_note', 255);
    t.timestamp('paid_at', { useTz: true });
    t.uuid('paid_by_admin_id').references('id').inTable('platform_admins');
    t.string('payment_note', 255);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['clinic_id', 'created_at']);
    t.index(['status', 'due_on']);
  });
  await knex.raw(`ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN ('OPEN', 'PAID', 'VOID'))`);
  await knex.raw('ALTER TABLE invoices ADD CONSTRAINT invoices_amount_check CHECK (amount_cents > 0)');
  // no máximo 1 fatura aberta por assinatura (o banco garante, sem corrida)
  await knex.raw(`CREATE UNIQUE INDEX invoices_one_open ON invoices (subscription_id) WHERE status = 'OPEN'`);
  await enableTenantRls(knex, 'invoices', { grants: 'SELECT, INSERT, UPDATE' });

  await knex.schema.createTable('billing_events', (t) => {
    uuidPk(knex, t);
    clinicFk(t);
    t.string('type', 40).notNullable();
    t.jsonb('data').notNullable().defaultTo('{}');
    t.string('actor', 80); // 'clinic:<id do usuário>', 'platform:<id do admin>' ou 'system'
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['clinic_id', 'created_at']);
  });
  await enableTenantRls(knex, 'billing_events', { grants: 'SELECT, INSERT' });

  // ---- aceite dos termos (prova para a LGPD): quem aceitou, qual versão, quando e de onde ----
  await knex.schema.createTable('terms_acceptances', (t) => {
    uuidPk(knex, t);
    clinicFk(t);
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.string('terms_version', 20).notNullable();
    t.string('privacy_version', 20).notNullable();
    t.timestamp('accepted_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.string('ip', 64);
    t.string('user_agent', 255);
    t.index('clinic_id');
  });
  await enableTenantRls(knex, 'terms_acceptances', { grants: 'SELECT, INSERT' });

  // Toda clínica nasce com a assinatura em período de teste (inclusive as criadas pela plataforma e pelos testes).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ensure_subscription() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO subscriptions (clinic_id, trial_ends_on) VALUES (NEW.id, ${TODAY_BR} + ${TRIAL_DAYS});
      RETURN NEW;
    END $$`);
  await knex.raw('CREATE TRIGGER clinics_subscription AFTER INSERT ON clinics FOR EACH ROW EXECUTE FUNCTION ensure_subscription()');
  // clínicas que já existem entram em teste a partir de hoje
  await knex.raw(`INSERT INTO subscriptions (clinic_id, trial_ends_on) SELECT id, ${TODAY_BR} + ${TRIAL_DAYS} FROM clinics`);
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS clinics_subscription ON clinics');
  await knex.raw('DROP FUNCTION IF EXISTS ensure_subscription()');
  await knex.schema.dropTableIfExists('terms_acceptances');
  await knex.schema.dropTableIfExists('billing_events');
  await knex.schema.dropTableIfExists('invoices');
  await knex.schema.dropTableIfExists('subscriptions');
  await knex.schema.alterTable('clinics', (t) => {
    t.dropColumn('template_code');
    t.dropColumn('prices_reviewed_at');
  });
  await knex.schema.dropTableIfExists('plans');
}
