import knex from 'knex';
import pg from 'pg';
import { buildKnexConfig } from './config.js';

// Colunas DATE chegam como texto 'AAAA-MM-DD' (sem fuso), em vez de virar um Date que muda de dia conforme o fuso do servidor.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

// Pool "dono": usado em autenticação, plataforma e migrations. NÃO aplica o isolamento por clínica (RLS);
// todo acesso a dados de uma clínica deve passar por withTenant (src/db/tenant.js).
const db = knex(buildKnexConfig());

export default db;
