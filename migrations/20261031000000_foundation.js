// Fundação: clínicas (tenant), usuários, administradores da plataforma e tokens de autenticação.
import { enableTenantRls, APP_ROLE } from '../src/db/rls.js';

const uuidPk = (knex, t) => t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

export async function up(knex) {
  // papel usado pela aplicação nas consultas de uma clínica (sujeito ao RLS)
  await knex.raw(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} NOLOGIN; END IF; END $$`);
  await knex.raw(`GRANT ${APP_ROLE} TO CURRENT_USER`);
  await knex.raw(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await knex.raw(`CREATE OR REPLACE FUNCTION app_current_clinic() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.clinic_id', true), '')::uuid $$`);

  await knex.schema.createTable('clinics', (t) => {
    uuidPk(knex, t);
    t.string('name', 160).notNullable();
    t.string('slug', 80).notNullable().unique();
    t.string('document', 20);
    t.string('plan', 40).notNullable().defaultTo('basic');
    t.string('status', 20).notNullable().defaultTo('active');
    t.timestamps(true, true);
  });
  await knex.raw(`ALTER TABLE clinics ADD CONSTRAINT clinics_status_check CHECK (status IN ('active', 'suspended'))`);
  // a clínica enxerga e edita apenas o próprio registro
  await enableTenantRls(knex, 'clinics', { column: 'id', grants: 'SELECT, UPDATE' });

  await knex.schema.createTable('platform_admins', (t) => {
    uuidPk(knex, t);
    t.string('name', 160).notNullable();
    t.string('email', 254).notNullable().unique();
    t.text('password_hash').notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('password_changed_at', { useTz: true });
    t.timestamps(true, true);
  });

  await knex.schema.createTable('users', (t) => {
    uuidPk(knex, t);
    t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');
    t.string('name', 160).notNullable();
    t.string('email', 254).notNullable().unique();
    t.text('password_hash').notNullable();
    t.string('role', 20).notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('email_verified_at', { useTz: true });
    t.timestamp('password_changed_at', { useTz: true });
    t.timestamps(true, true);
    t.index('clinic_id');
  });
  await knex.raw(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'secretary', 'dentist'))`);
  await enableTenantRls(knex, 'users');

  await knex.schema.createTable('refresh_tokens', (t) => {
    uuidPk(knex, t);
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');
    t.string('token_hash', 64).notNullable().unique();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('revoked_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index('user_id');
  });
  await enableTenantRls(knex, 'refresh_tokens');

  await knex.schema.createTable('auth_tokens', (t) => {
    uuidPk(knex, t);
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');
    t.string('type', 30).notNullable();
    t.string('token_hash', 64).notNullable().unique();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['user_id', 'type']);
  });
  await knex.raw(`ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_type_check CHECK (type IN ('email_verification', 'password_reset'))`);
  await enableTenantRls(knex, 'auth_tokens');
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('auth_tokens');
  await knex.schema.dropTableIfExists('refresh_tokens');
  await knex.schema.dropTableIfExists('users');
  await knex.schema.dropTableIfExists('platform_admins');
  await knex.schema.dropTableIfExists('clinics');
  await knex.raw('DROP FUNCTION IF EXISTS app_current_clinic()');
}
