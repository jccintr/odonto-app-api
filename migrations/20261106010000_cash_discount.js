// Desconto sugerido para pagamento à vista (percentual), configurado pela clínica; 0 = sem sugestão.
export async function up(knex) {
  await knex.raw('ALTER TABLE clinics ADD COLUMN cash_discount_percent smallint NOT NULL DEFAULT 0');
  await knex.raw('ALTER TABLE clinics ADD CONSTRAINT clinics_cash_discount_check CHECK (cash_discount_percent BETWEEN 0 AND 50)');
}

export async function down(knex) {
  await knex.raw('ALTER TABLE clinics DROP COLUMN cash_discount_percent');
}
