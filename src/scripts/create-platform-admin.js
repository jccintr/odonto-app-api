// Cria um administrador da plataforma (quem cadastra as clínicas).
// Uso: npm run platform-admin:create -- "Nome" email@dominio.com senha-com-8-ou-mais-caracteres
import 'dotenv/config';
import db from '../db/knex.js';
import { createPlatformAdmin } from '../modules/platform/platform.service.js';

const [name, email, password] = process.argv.slice(2);

try {
  if (!name || !email || !password || password.length < 8) {
    throw new Error('Uso: npm run platform-admin:create -- "Nome" email senha (senha com 8+ caracteres)');
  }
  const admin = await createPlatformAdmin({ name, email, password });
  console.log(`Administrador criado: ${admin.name} <${admin.email}>`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
