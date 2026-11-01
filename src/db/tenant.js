import db from './knex.js';
import { APP_ROLE } from './rls.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Executa fn(trx) dentro de uma transação restrita a UMA clínica: o papel muda para o da aplicação (sujeito ao RLS)
 * e a clínica fica gravada na sessão só durante a transação. Qualquer consulta feita com trx só enxerga essa clínica.
 */
export async function withTenant(clinicId, fn) {
  if (!UUID_RE.test(String(clinicId))) throw new Error('withTenant: clinicId inválido.');
  return db.transaction(async (trx) => {
    await trx.raw(`SET LOCAL ROLE ${APP_ROLE}`);
    await trx.raw("SELECT set_config('app.clinic_id', ?, true)", [clinicId]);
    return fn(trx);
  });
}
