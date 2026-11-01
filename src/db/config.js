import { fileURLToPath } from 'node:url';
import { config } from '../config/env.js';

// Configuração do knex (usada pela aplicação, pelo knexfile e pelos testes).
export function buildKnexConfig() {
  return {
    client: 'pg',
    connection: {
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
    },
    pool: { min: 0, max: config.dbPoolMax },
    migrations: { directory: fileURLToPath(new URL('../../migrations', import.meta.url)) },
  };
}
