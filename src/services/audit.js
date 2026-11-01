// Registro de auditoria (tabela append-only). Guarda quem fez o quê; para alterações, só os NOMES dos campos
// (nunca os valores: o log não duplica dados de saúde).
export const recordAudit = (trx, { clinicId, userId, entity, entityId, action, changes = null }) =>
  trx('audit_log').insert({ clinic_id: clinicId, user_id: userId, entity, entity_id: entityId, action, changes });
