// Isolamento por clínica no próprio banco (Row Level Security).
// O papel da aplicação (APP_ROLE) não é dono das tabelas, então as políticas valem para ele.
export const APP_ROLE = 'odonto_app';

/**
 * Liga o RLS numa tabela que tem a coluna da clínica e cria a política de isolamento.
 * Toda migration que cria uma tabela com clinic_id deve chamar isto (há um teste que garante).
 */
export async function enableTenantRls(knex, table, { column = 'clinic_id', grants = 'SELECT, INSERT, UPDATE, DELETE' } = {}) {
  await knex.raw('ALTER TABLE ?? ENABLE ROW LEVEL SECURITY', [table]);
  await knex.raw(
    `CREATE POLICY tenant_isolation ON ?? USING (?? = app_current_clinic()) WITH CHECK (?? = app_current_clinic())`,
    [table, column, column],
  );
  await knex.raw(`GRANT ${grants} ON ?? TO ${APP_ROLE}`, [table]);
}
