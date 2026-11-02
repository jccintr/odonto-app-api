// LGPD: o administrador exporta todos os dados da clínica e pode pedir a exclusão da conta.
// Funciona mesmo com a assinatura suspensa (a clínica nunca fica refém dos próprios dados).
import db from '../../db/knex.js';
import { withTenant } from '../../db/tenant.js';
import { verifyPassword } from '../../services/password.js';
import { badRequest } from '../../utils/errors.js';
import { toClinicDto } from '../../utils/dto.js';
import { notifyOwner } from '../billing/notify.js';
import { logEvent } from '../billing/billing.service.js';

// segredos e tokens nunca saem na exportação
const SKIP_TABLES = new Set(['refresh_tokens', 'auth_tokens']);
const SKIP_COLUMNS = new Set(['password_hash', 'token_hash']);
const stripSecrets = (row) => Object.fromEntries(Object.entries(row).filter(([column]) => !SKIP_COLUMNS.has(column)));

/** Todas as tabelas que têm clinic_id, lidas dentro do isolamento da clínica (nenhuma linha de outra clínica entra). */
export async function exportData(clinicId) {
  const { rows } = await db.raw("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'clinic_id' ORDER BY table_name");
  const tables = rows.map((r) => r.table_name).filter((name) => !SKIP_TABLES.has(name));
  return withTenant(clinicId, async (trx) => {
    const data = {};
    for (const table of tables) data[table] = (await trx(table).select()).map(stripSecrets);
    return { exportedAt: new Date().toISOString(), clinic: toClinicDto(await trx('clinics').first()), tables: data };
  });
}

/** Registra o pedido (a exclusão em si é feita pelo dono da plataforma, que confere o que a lei obriga a guardar). Repetir o pedido não faz nada. */
export async function requestDeletion(clinicId, user, password) {
  if (!(await verifyPassword(password, user.password_hash))) throw badRequest('Senha incorreta.', { code: 'WRONG_PASSWORD' });
  const { requestedAt, isNew, clinicName } = await withTenant(clinicId, async (trx) => {
    const updated = await trx('subscriptions').where({ clinic_id: clinicId }).whereNull('deletion_requested_at').update({ deletion_requested_at: new Date() });
    if (updated > 0) await logEvent(trx, clinicId, 'deletion_requested', {}, `clinic:${user.id}`);
    return {
      requestedAt: (await trx('subscriptions').first('deletion_requested_at')).deletion_requested_at,
      isNew: updated > 0,
      clinicName: (await trx('clinics').first('name')).name,
    };
  });
  if (isNew) await notifyOwner('Pedido de exclusão de dados (LGPD)', [`A clínica "${clinicName}" (${user.email}) pediu a exclusão da conta e dos dados.`]);
  return { deletionRequestedAt: requestedAt };
}

export async function cancelDeletion(clinicId, userId) {
  await withTenant(clinicId, async (trx) => {
    await trx('subscriptions').where({ clinic_id: clinicId }).update({ deletion_requested_at: null });
    await logEvent(trx, clinicId, 'deletion_canceled', {}, `clinic:${userId}`);
  });
  return { deletionRequestedAt: null };
}
