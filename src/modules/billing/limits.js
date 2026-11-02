// Limite de dentistas do plano. Durante o teste (sem plano escolhido) não há limite.
import { unprocessable } from '../../utils/errors.js';

/** Chame dentro de withTenant antes de criar, reativar ou transformar alguém em dentista ativo. */
export async function assertDentistSlot(trx) {
  const plan = await trx('subscriptions').join('plans', 'plans.id', 'subscriptions.plan_id').first('plans.name', 'plans.max_dentists');
  if (!plan || plan.max_dentists === null) return;
  const [{ count }] = await trx('users').where({ role: 'dentist', active: true }).count({ count: '*' });
  if (Number(count) >= plan.max_dentists) {
    throw unprocessable(
      `O plano ${plan.name} permite até ${plan.max_dentists} dentista(s) ativo(s). Para cadastrar mais, escolha um plano maior na tela Assinatura.`,
      { code: 'PLAN_LIMIT' },
    );
  }
}
