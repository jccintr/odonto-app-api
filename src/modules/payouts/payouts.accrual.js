// Gera o lançamento de repasse quando um procedimento é realizado. Chamado de dentro da transação de budgets.performItem.
import { commissionFor, netOfDiscount, pickRule } from '../../utils/payouts.js';
import { loadSettings, termsOf } from './payouts.settings.js';

/** Regra aplicável a (dentista, procedimento) com as configurações atuais da clínica. */
export async function resolveRule(trx, { dentistId, procedureId }, settings) {
  const dentist = await trx('dentists').where({ id: dentistId }).first('payout_percent');
  const rules = await trx('payout_rules')
    .where({ procedure_id: procedureId })
    .where((q) => q.where({ dentist_id: dentistId }).orWhereNull('dentist_id'));
  return pickRule(rules, {
    dentistId, procedureId, dentistPercent: dentist.payout_percent, defaultPercent: settings.default_percent,
  });
}

/** Congela a regra e o valor da comissão do item. Só vale daqui para frente: mudar a configuração depois não altera lançamentos antigos. */
export async function recordExecution(trx, { auth, budget, item, dentistId, performedAt }) {
  const settings = await loadSettings(trx);
  const procedure = await trx('procedures').where({ id: item.procedure_id }).first('cost_cents');
  const gross = netOfDiscount(item.price_cents, budget.subtotal, budget.discount_cents);
  const cost = settings.deduct_costs ? Math.min(procedure.cost_cents, gross) : 0;
  const base = gross - cost;
  const { source, rule } = await resolveRule(trx, { dentistId, procedureId: item.procedure_id }, settings);
  await trx('payout_entries').insert({
    clinic_id: auth.clinicId, budget_id: budget.id, item_id: item.id, patient_id: budget.patient_id, dentist_id: dentistId,
    performed_at: performedAt, gross_cents: gross, cost_cents: cost, base_cents: base,
    rule_source: source, rule_type: rule.type, rule_percent: rule.type === 'percent' ? rule.percent : null,
    rule_fixed_cents: rule.type === 'fixed' ? rule.fixed_cents : null,
    commission_cents: commissionFor(base, rule), terms: JSON.stringify(termsOf(settings)),
  });
}
