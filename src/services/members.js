// Pessoa (users) + vínculo com a clínica (memberships) + perfil clínico ativo (dentists), numa linha só.
// É o formato usado em sessão, autenticação e gestão de usuários: tem os campos da pessoa e, por cima, os do vínculo
// (clinic_id, role, active, accepted_at), além de dentist_id quando a pessoa atende pacientes nesta clínica.

export const MEMBER_COLUMNS = [
  'users.id', 'users.name', 'users.email', 'users.phone', 'users.password_hash', 'users.email_verified_at', 'users.password_changed_at',
  'memberships.id as membership_id', 'memberships.clinic_id', 'memberships.role', 'memberships.active', 'memberships.accepted_at',
  'memberships.created_at', 'dentists.id as dentist_id',
];

/** Vínculos com a pessoa e o perfil clínico, sem colunas (para contar). `q` é o knex (dono) ou uma transação de withTenant. */
export const membersBase = (q) =>
  q('memberships')
    .join('users', 'users.id', 'memberships.user_id')
    .leftJoin('dentists', (join) => {
      join.on('dentists.clinic_id', 'memberships.clinic_id').andOn('dentists.user_id', 'memberships.user_id').andOnVal('dentists.active', true);
    });

/** Vínculos com a pessoa e o perfil clínico, já com as colunas da linha de membro. */
export const membersQuery = (q) =>
  membersBase(q).select(MEMBER_COLUMNS).select(q.raw('GREATEST(users.updated_at, memberships.updated_at) AS updated_at'));

/** O vínculo da pessoa com a clínica (ou undefined). */
export const findMember = (q, userId, clinicId) =>
  membersQuery(q).where({ 'memberships.user_id': userId, 'memberships.clinic_id': clinicId }).first();

/** Atende pacientes nesta clínica: o vínculo está ativo e tem perfil clínico ligado. */
export const isClinical = (member) => Boolean(member.active && member.dentist_id);

/**
 * Liga ou desliga o perfil clínico do vínculo. Ligar cria o perfil na primeira vez e reaproveita o mesmo depois
 * (o histórico do dentista continua no mesmo perfil). Desligar nunca apaga nada.
 */
export async function setClinicalProfile(trx, clinicId, userId, attends) {
  if (attends) {
    await trx('dentists').insert({ clinic_id: clinicId, user_id: userId })
      .onConflict(['clinic_id', 'user_id']).merge({ active: true, updated_at: new Date() });
  } else {
    await trx('dentists').where({ clinic_id: clinicId, user_id: userId, active: true }).update({ active: false, updated_at: new Date() });
  }
}
