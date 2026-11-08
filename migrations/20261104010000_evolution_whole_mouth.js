// Cada procedimento do prontuário diz onde foi feito: um dente (FDI) ou "boca toda" (profilaxia, orientação, etc.).
export async function up(knex) {
  await knex.schema.alterTable('evolution_items', (t) => {
    t.boolean('whole_mouth').notNullable().defaultTo(false);
  });
  await knex.raw('ALTER TABLE evolution_items ADD CONSTRAINT evolution_items_where_check CHECK (NOT (whole_mouth AND tooth IS NOT NULL))');
}

export async function down(knex) {
  await knex.raw('ALTER TABLE evolution_items DROP CONSTRAINT IF EXISTS evolution_items_where_check');
  await knex.schema.alterTable('evolution_items', (t) => t.dropColumn('whole_mouth'));
}
