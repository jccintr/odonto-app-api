// Limite de dentistas do plano. Durante o teste (sem plano escolhido) não há limite.
import { unprocessable } from '../../utils/errors.js';

/** Quantos atendem pacientes na clínica: vínculos ativos com perfil clínico ligado (dentistas e administradores que atendem). Use dentro de withTenant. */
export async function countActiveDentists(trx) {
  const [{ count }] = await trx('dentists')
    .join('memberships', (join) => join.on('memberships.clinic_id', 'dentists.clinic_id').andOn('memberships.user_id', 'dentists.user_id'))
    .where({ 'dentists.active': true, 'memberships.active': true })
    .count({ count: '*' });
  return Number(count);
}

/** Chame dentro de withTenant antes de alguém passar a atender pacientes (novo dentista, reativação, administrador que liga o atendimento). */
export async function assertDentistSlot(trx) {
  const plan = await trx('subscriptions').join('plans', 'plans.id', 'subscriptions.plan_id').first('plans.name', 'plans.max_dentists');
  if (!plan || plan.max_dentists === null) return;
  if ((await countActiveDentists(trx)) >= plan.max_dentists) {
    throw unprocessable(
      `O plano ${plan.name} permite até ${plan.max_dentists} dentista(s) ativo(s). Para cadastrar mais, escolha um plano maior na tela Assinatura.`,
      { code: 'PLAN_LIMIT' },
    );
  }
}
