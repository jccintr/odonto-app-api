// Pessoa x vínculo com a clínica.
// Antes: um usuário pertencia a UMA clínica e o e-mail era único no sistema todo, então um dentista que trocava de clínica
// (ou atendia em duas) não conseguia ser cadastrado de novo, e o administrador de uma clínica pequena não podia ser o dentista.
// Agora:
// - users       = a PESSOA (login global: nome, e-mail, senha). Sem clínica, sem perfil.
// - memberships = o VÍNCULO da pessoa com uma clínica: perfil (admin, secretary, dentist), situação e aceite do convite.
// - dentists    = o perfil clínico de um vínculo. `active` = atende pacientes nesta clínica (dentista sempre; administrador, se quiser).
// O histórico (prontuário, agenda, repasses) continua ligado ao perfil do dentista na clínica, que nunca é apagado.
import { APP_ROLE, enableTenantRls } from '../src/db/rls.js';

const MEMBER_OF_CLINIC = 'EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.clinic_id = app_current_clinic())';

export async function up(knex) {
  await knex.schema.createTable('memberships', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('clinic_id').notNullable().references('id').inTable('clinics').onDelete('RESTRICT');
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    t.string('role', 20).notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('accepted_at', { useTz: true }); // null = convite pendente (a pessoa já tinha conta e ainda não aceitou)
    t.uuid('invited_by');
    t.timestamps(true, true);
    t.unique(['clinic_id', 'user_id']);
    t.index('user_id');
  });
  await knex.raw(`ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('admin', 'secretary', 'dentist'))`);
  await enableTenantRls(knex, 'memberships');
  await knex.raw(`
    INSERT INTO memberships (clinic_id, user_id, role, active, accepted_at, created_at, updated_at)
    SELECT clinic_id, id, role, active, created_at, created_at, updated_at FROM users`);

  // ---- perfil clínico: passa a pertencer ao vínculo (uma pessoa pode ter um perfil em cada clínica) ----
  await knex.raw('ALTER TABLE dentists ADD COLUMN active boolean NOT NULL DEFAULT true');
  // quem foi rebaixado de dentista mantém o histórico, mas deixa de atender
  await knex.raw(`UPDATE dentists SET active = false FROM users WHERE users.id = dentists.user_id AND users.role <> 'dentist'`);
  await knex.raw('ALTER TABLE dentists DROP CONSTRAINT dentists_clinic_id_user_id_foreign');
  await knex.raw('ALTER TABLE dentists DROP CONSTRAINT dentists_user_id_unique');
  await knex.raw('ALTER TABLE dentists ADD CONSTRAINT dentists_clinic_id_user_id_unique UNIQUE (clinic_id, user_id)');
  await knex.raw(`ALTER TABLE dentists ADD CONSTRAINT dentists_clinic_id_user_id_foreign
    FOREIGN KEY (clinic_id, user_id) REFERENCES memberships (clinic_id, user_id) ON DELETE RESTRICT`);

  // o gatilho sai de users e vai para memberships: virar dentista cria (ou reativa) o perfil; virar secretária desliga o atendimento
  await knex.raw('DROP TRIGGER users_dentist_profile ON users');
  await knex.raw('DROP FUNCTION ensure_dentist_profile()');
  await knex.raw(`
    CREATE FUNCTION ensure_dentist_profile() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.role = 'dentist' THEN
        INSERT INTO dentists (clinic_id, user_id) VALUES (NEW.clinic_id, NEW.user_id)
          ON CONFLICT (clinic_id, user_id) DO UPDATE SET active = true, updated_at = now();
      ELSIF NEW.role = 'secretary' THEN
        UPDATE dentists SET active = false, updated_at = now() WHERE clinic_id = NEW.clinic_id AND user_id = NEW.user_id AND active;
      END IF;
      RETURN NEW;
    END $$`);
  await knex.raw('CREATE TRIGGER memberships_dentist_profile AFTER INSERT OR UPDATE OF role ON memberships FOR EACH ROW EXECUTE FUNCTION ensure_dentist_profile()');

  // ---- users vira a pessoa: sai a clínica, o perfil e a situação (tudo isso agora é do vínculo) ----
  await knex.raw('DROP POLICY tenant_isolation ON users');
  await knex.raw('ALTER TABLE users DROP CONSTRAINT users_clinic_id_id_unique');
  await knex.raw('ALTER TABLE users DROP CONSTRAINT users_role_check');
  await knex.raw('ALTER TABLE users DROP COLUMN clinic_id, DROP COLUMN role, DROP COLUMN active');
  // a clínica enxerga (e corrige o nome de) quem tem vínculo com ela; cadastrar uma pessoa nova não depende de clínica
  await knex.raw(`CREATE POLICY member_select ON users FOR SELECT USING (${MEMBER_OF_CLINIC})`);
  await knex.raw(`CREATE POLICY member_update ON users FOR UPDATE USING (${MEMBER_OF_CLINIC}) WITH CHECK (${MEMBER_OF_CLINIC})`);
  await knex.raw('CREATE POLICY person_insert ON users FOR INSERT WITH CHECK (true)');
  await knex.raw(`REVOKE DELETE ON users FROM ${APP_ROLE}`);

  // ---- tokens de e-mail: verificação e senha são da pessoa (sem clínica); o convite é de uma clínica ----
  await knex.raw('ALTER TABLE auth_tokens ALTER COLUMN clinic_id DROP NOT NULL');
  await knex.raw('UPDATE auth_tokens SET clinic_id = NULL');
  await knex.raw('ALTER TABLE auth_tokens DROP CONSTRAINT auth_tokens_type_check');
  await knex.raw(`ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_type_check CHECK (type IN ('email_verification', 'password_reset', 'membership_invite'))`);
  await knex.raw(`ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_invite_clinic_check CHECK ((type = 'membership_invite') = (clinic_id IS NOT NULL))`);
}

// Volta ao modelo antigo. Só é possível enquanto cada pessoa tiver um único vínculo (o modelo antigo não representa mais de um).
export async function down(knex) {
  const { rows } = await knex.raw('SELECT user_id FROM memberships GROUP BY user_id HAVING count(*) > 1 LIMIT 1');
  if (rows.length > 0) throw new Error('Há pessoas com vínculo em mais de uma clínica: não dá para voltar ao modelo de um usuário por clínica.');

  await knex.raw(`DELETE FROM auth_tokens WHERE type = 'membership_invite'`);
  await knex.raw('ALTER TABLE auth_tokens DROP CONSTRAINT auth_tokens_invite_clinic_check');
  await knex.raw('ALTER TABLE auth_tokens DROP CONSTRAINT auth_tokens_type_check');
  await knex.raw(`ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_type_check CHECK (type IN ('email_verification', 'password_reset'))`);
  await knex.raw('UPDATE auth_tokens SET clinic_id = m.clinic_id FROM memberships m WHERE m.user_id = auth_tokens.user_id');
  await knex.raw('DELETE FROM auth_tokens WHERE clinic_id IS NULL');
  await knex.raw('ALTER TABLE auth_tokens ALTER COLUMN clinic_id SET NOT NULL');

  await knex.raw('DROP POLICY member_select ON users');
  await knex.raw('DROP POLICY member_update ON users');
  await knex.raw('DROP POLICY person_insert ON users');
  await knex.raw(`GRANT DELETE ON users TO ${APP_ROLE}`);
  await knex.raw('ALTER TABLE users ADD COLUMN clinic_id uuid REFERENCES clinics (id) ON DELETE RESTRICT, ADD COLUMN role varchar(20), ADD COLUMN active boolean NOT NULL DEFAULT true');
  await knex.raw('UPDATE users SET clinic_id = m.clinic_id, role = m.role, active = m.active FROM memberships m WHERE m.user_id = users.id');
  // pessoa sem vínculo (não acontece pelo sistema) não cabe no modelo antigo
  await knex.raw('DELETE FROM users WHERE clinic_id IS NULL');
  await knex.raw('ALTER TABLE users ALTER COLUMN clinic_id SET NOT NULL, ALTER COLUMN role SET NOT NULL');
  await knex.raw(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'secretary', 'dentist'))`);
  await knex.raw('ALTER TABLE users ADD CONSTRAINT users_clinic_id_id_unique UNIQUE (clinic_id, id)');
  await knex.raw('CREATE INDEX users_clinic_id_index ON users (clinic_id)');
  await knex.raw('CREATE POLICY tenant_isolation ON users USING (clinic_id = app_current_clinic()) WITH CHECK (clinic_id = app_current_clinic())');

  await knex.raw('DROP TRIGGER memberships_dentist_profile ON memberships');
  await knex.raw('DROP FUNCTION ensure_dentist_profile()');
  await knex.raw(`
    CREATE FUNCTION ensure_dentist_profile() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.role = 'dentist' THEN
        INSERT INTO dentists (clinic_id, user_id) VALUES (NEW.clinic_id, NEW.id) ON CONFLICT (user_id) DO NOTHING;
      END IF;
      RETURN NEW;
    END $$`);

  await knex.raw('ALTER TABLE dentists DROP CONSTRAINT dentists_clinic_id_user_id_foreign');
  await knex.raw('ALTER TABLE dentists DROP CONSTRAINT dentists_clinic_id_user_id_unique');
  await knex.raw('ALTER TABLE dentists ADD CONSTRAINT dentists_user_id_unique UNIQUE (user_id)');
  await knex.raw('ALTER TABLE dentists ADD CONSTRAINT dentists_clinic_id_user_id_foreign FOREIGN KEY (clinic_id, user_id) REFERENCES users (clinic_id, id) ON DELETE RESTRICT');
  await knex.raw('ALTER TABLE dentists DROP COLUMN active');
  await knex.raw('CREATE TRIGGER users_dentist_profile AFTER INSERT OR UPDATE OF role ON users FOR EACH ROW EXECUTE FUNCTION ensure_dentist_profile()');

  await knex.schema.dropTable('memberships');
}
