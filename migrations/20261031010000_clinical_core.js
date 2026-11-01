// Núcleo clínico: dentistas, pacientes, procedimentos, agenda e auditoria.
// Todas as tabelas têm clinic_id + RLS. As chaves estrangeiras são COMPOSTAS (clinic_id, id): mesmo que o código erre,
// o banco não deixa um agendamento de uma clínica apontar para paciente ou dentista de outra.
import { enableTenantRls } from '../src/db/rls.js';

const uuidPk = (knex, t) => t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
const clinicFk = (t) => t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');

export async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS btree_gist'); // restrição de horário sobreposto por dentista
  await knex.raw('ALTER TABLE users ADD CONSTRAINT users_clinic_id_id_unique UNIQUE (clinic_id, id)');

  // ---- dentistas: perfil profissional de um usuário com perfil "dentist" ----
  await knex.schema.createTable('dentists', (t) => {
    uuidPk(knex, t);
    clinicFk(t);
    t.uuid('user_id').notNullable().unique();
    t.string('cro', 30);
    t.string('specialty', 80);
    t.string('color', 7).notNullable().defaultTo('#0f766e');
    t.decimal('payout_percent', 5, 2); // % de repasse padrão (a regra completa de repasse vem depois)
    t.timestamps(true, true);
    t.unique(['clinic_id', 'id']);
    t.foreign(['clinic_id', 'user_id']).references(['clinic_id', 'id']).inTable('users').onDelete('RESTRICT');
  });
  await knex.raw('ALTER TABLE dentists ADD CONSTRAINT dentists_payout_check CHECK (payout_percent IS NULL OR (payout_percent >= 0 AND payout_percent <= 100))');
  await enableTenantRls(knex, 'dentists');

  // todo usuário com perfil "dentist" ganha o perfil profissional automaticamente (criado ou promovido a dentista)
  await knex.raw(`
    CREATE FUNCTION ensure_dentist_profile() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.role = 'dentist' THEN
        INSERT INTO dentists (clinic_id, user_id) VALUES (NEW.clinic_id, NEW.id) ON CONFLICT (user_id) DO NOTHING;
      END IF;
      RETURN NEW;
    END $$`);
  await knex.raw('CREATE TRIGGER users_dentist_profile AFTER INSERT OR UPDATE OF role ON users FOR EACH ROW EXECUTE FUNCTION ensure_dentist_profile()');
  await knex.raw("INSERT INTO dentists (clinic_id, user_id) SELECT clinic_id, id FROM users WHERE role = 'dentist' ON CONFLICT (user_id) DO NOTHING");

  // ---- pacientes ----
  await knex.schema.createTable('patients', (t) => {
    uuidPk(knex, t);
    clinicFk(t);
    t.string('name', 160).notNullable();
    t.string('cpf', 11);
    t.date('birth_date');
    t.string('phone', 11);
    t.string('email', 254);
    t.string('zip', 8);
    t.string('street', 160);
    t.string('number', 20);
    t.string('complement', 80);
    t.string('district', 80);
    t.string('city', 80);
    t.string('state', 2);
    t.string('guardian_name', 160);
    t.string('guardian_phone', 11);
    t.jsonb('anamnesis').notNullable().defaultTo('{}');
    t.text('notes');
    t.boolean('contact_consent').notNullable().defaultTo(false);
    t.timestamp('consent_at', { useTz: true });
    t.boolean('active').notNullable().defaultTo(true);
    t.uuid('created_by');
    t.timestamps(true, true);
    t.unique(['clinic_id', 'id']);
    t.index(['clinic_id', 'name']);
  });
  await knex.raw('CREATE UNIQUE INDEX patients_clinic_cpf_unique ON patients (clinic_id, cpf) WHERE cpf IS NOT NULL');
  await enableTenantRls(knex, 'patients');

  // ---- procedimentos (tabela de preços da clínica) ----
  await knex.schema.createTable('procedures', (t) => {
    uuidPk(knex, t);
    clinicFk(t);
    t.string('name', 160).notNullable();
    t.string('category', 80);
    t.integer('price_cents').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamps(true, true);
    t.unique(['clinic_id', 'id']);
    t.unique(['clinic_id', 'name']);
  });
  await knex.raw('ALTER TABLE procedures ADD CONSTRAINT procedures_price_check CHECK (price_cents >= 0)');
  await enableTenantRls(knex, 'procedures');

  // ---- agenda ----
  await knex.schema.createTable('appointments', (t) => {
    uuidPk(knex, t);
    clinicFk(t);
    t.uuid('patient_id').notNullable();
    t.uuid('dentist_id').notNullable();
    t.timestamp('starts_at', { useTz: true }).notNullable();
    t.timestamp('ends_at', { useTz: true }).notNullable();
    t.string('status', 20).notNullable().defaultTo('scheduled');
    t.text('notes');
    t.string('canceled_reason', 240);
    t.uuid('created_by');
    t.timestamps(true, true);
    t.index(['clinic_id', 'starts_at']);
    t.index('patient_id');
    t.foreign(['clinic_id', 'patient_id']).references(['clinic_id', 'id']).inTable('patients').onDelete('RESTRICT');
    t.foreign(['clinic_id', 'dentist_id']).references(['clinic_id', 'id']).inTable('dentists').onDelete('RESTRICT');
  });
  await knex.raw(`ALTER TABLE appointments ADD CONSTRAINT appointments_status_check CHECK (status IN ('scheduled', 'confirmed', 'attended', 'no_show', 'canceled'))`);
  await knex.raw('ALTER TABLE appointments ADD CONSTRAINT appointments_period_check CHECK (ends_at > starts_at)');
  // um dentista não pode ter dois atendimentos ativos que se sobreponham (garantido pelo banco, sem corrida)
  await knex.raw(`ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
    EXCLUDE USING gist (dentist_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status <> 'canceled')`);
  await enableTenantRls(knex, 'appointments');

  // ---- auditoria (só acrescenta: a aplicação não altera nem apaga registros) ----
  await knex.schema.createTable('audit_log', (t) => {
    uuidPk(knex, t);
    clinicFk(t);
    t.uuid('user_id').notNullable();
    t.string('entity', 40).notNullable();
    t.uuid('entity_id').notNullable();
    t.string('action', 20).notNullable();
    t.jsonb('changes');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['clinic_id', 'entity', 'entity_id', 'created_at']);
  });
  await enableTenantRls(knex, 'audit_log', { grants: 'SELECT, INSERT' });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('audit_log');
  await knex.schema.dropTableIfExists('appointments');
  await knex.schema.dropTableIfExists('procedures');
  await knex.schema.dropTableIfExists('patients');
  await knex.raw('DROP TRIGGER IF EXISTS users_dentist_profile ON users');
  await knex.raw('DROP FUNCTION IF EXISTS ensure_dentist_profile()');
  await knex.schema.dropTableIfExists('dentists');
  await knex.raw('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_clinic_id_id_unique');
}
