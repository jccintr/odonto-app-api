// Telefone da pessoa da equipe (administrador, secretária, dentista). É da pessoa, como o nome: vale em todas as clínicas dela.
// Guardado só com dígitos (DDD + número, 10 ou 11 dígitos), como o telefone do paciente.
export async function up(knex) {
  await knex.raw('ALTER TABLE users ADD COLUMN phone varchar(11)');
  await knex.raw("ALTER TABLE users ADD CONSTRAINT users_phone_check CHECK (phone IS NULL OR phone ~ '^[0-9]{10,11}$')");
}

export async function down(knex) {
  await knex.raw('ALTER TABLE users DROP COLUMN phone');
}
