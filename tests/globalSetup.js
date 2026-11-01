// Antes de todos os testes: garante um PostgreSQL de teste com as migrations aplicadas.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knex from 'knex';

const MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function startEmbedded() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odonto-pg-'));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    // persistent: true = a limpeza do diretório fica por nossa conta (abaixo), com novas tentativas para o Windows
    databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: true, onLog: () => {}, onError: () => {},
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('odonto_test');
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/odonto_test`,
    stop: async () => {
      await server.stop();
      // No Windows os arquivos do PostgreSQL demoram um instante para ser liberados (EBUSY): tenta de novo e,
      // se não der, deixa a pasta temporária para o sistema limpar em vez de derrubar a execução dos testes.
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch {
        /* limpeza de pasta temporária é só um favor */
      }
    },
  };
}

export default async function setup({ provide }) {
  let url = process.env.TEST_DATABASE_URL;
  let stop = async () => {};

  if (url) {
    if (!new URL(url).pathname.endsWith('_test')) {
      throw new Error('TEST_DATABASE_URL precisa apontar para um banco cujo nome termina com _test (os testes apagam todas as tabelas).');
    }
  } else {
    ({ url, stop } = await startEmbedded());
  }

  const db = knex({ client: 'pg', connection: url, migrations: { directory: MIGRATIONS } });
  await db.migrate.latest();
  await db.destroy();

  provide('databaseUrl', url);
  return stop;
}
