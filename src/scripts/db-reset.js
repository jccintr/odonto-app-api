// Zera o banco de DESENVOLVIMENTO: apaga todas as tabelas e roda as migrations do zero.
// Uso: npm run db:reset -- --yes
//
// Por que não `migrate:rollback --all`? O rollback desfaz as migrations uma a uma, e algumas não têm volta quando há dados
// que o modelo antigo não representa (ex.: uma pessoa com vínculo em duas clínicas). Para começar do zero, apagar tudo é o certo.
//
// Proteções: recusa com NODE_ENV=production, exige --yes e só aceita banco em localhost (para outro host, --remote).
import 'dotenv/config';
import knex from 'knex';
import { buildKnexConfig } from '../db/config.js';

const args = new Set(process.argv.slice(2));
const config = buildKnexConfig();
const { hostname, pathname } = new URL(config.connection.connectionString);
const database = pathname.slice(1);
const local = ['localhost', '127.0.0.1', '::1'].includes(hostname);

if (process.env.NODE_ENV === 'production') {
  console.error('Recusado: NODE_ENV=production. Este comando é só para o banco de desenvolvimento.');
  process.exit(1);
}
if (!local && !args.has('--remote')) {
  console.error(`Recusado: o banco "${database}" está em ${hostname}, não em localhost. Se é mesmo para apagá-lo, rode de novo com --remote.`);
  process.exit(1);
}
if (!args.has('--yes')) {
  console.error(`Isto APAGA todos os dados do banco "${database}" em ${hostname}. Para confirmar: npm run db:reset -- --yes`);
  process.exit(1);
}

const db = knex(config);
try {
  await db.raw('DROP SCHEMA public CASCADE');
  await db.raw('CREATE SCHEMA public');
  const [batch, files] = await db.migrate.latest();
  console.log(`Banco "${database}" zerado. Migrations aplicadas (lote ${batch}): ${files.length}.`);
} catch (err) {
  console.error('Falha ao zerar o banco:', err.message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
