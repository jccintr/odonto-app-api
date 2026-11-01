// Regras de cálculo do repasse (funções puras: sem banco, fáceis de testar). Valores em centavos, percentuais com 2 casas.
export const PAYOUT_RELEASE_MODES = ['payment', 'procedure']; // libera conforme o paciente paga | quando o procedimento é realizado
export const PAYOUT_RULE_TYPES = ['percent', 'fixed'];
export const PAYOUT_RULE_SOURCES = ['dentist_procedure', 'procedure', 'dentist', 'clinic_default'];
export const PAYOUT_STATUSES = ['paid', 'canceled'];

/** percent pode vir como string do Postgres ('30.00'); trabalha em centésimos de ponto percentual para não usar ponto flutuante. */
export const toBasisPoints = (percent) => Math.round(Number(percent) * 100);

/** Parte de um valor: percentOf(1000, 12.5) = 125. */
export const percentOf = (cents, percent) => Math.round((cents * toBasisPoints(percent)) / 10000);

/** Parte do desconto do orçamento que cabe a um item (proporcional ao preço), para o repasse sair sobre o que o paciente realmente paga. */
export function netOfDiscount(priceCents, subtotalCents, discountCents) {
  if (subtotalCents <= 0 || discountCents <= 0) return priceCents;
  return priceCents - Math.round((discountCents * priceCents) / subtotalCents);
}

/**
 * Escolhe a regra aplicável. Do mais específico ao mais geral:
 * dentista + procedimento > procedimento (qualquer dentista) > percentual do dentista > percentual padrão da clínica.
 */
export function pickRule(rules, { dentistId, procedureId, dentistPercent, defaultPercent }) {
  const exact = rules.find((r) => r.procedure_id === procedureId && r.dentist_id === dentistId);
  if (exact) return { source: 'dentist_procedure', rule: exact };
  const general = rules.find((r) => r.procedure_id === procedureId && r.dentist_id === null);
  if (general) return { source: 'procedure', rule: general };
  if (dentistPercent !== null && dentistPercent !== undefined) {
    return { source: 'dentist', rule: { type: 'percent', percent: dentistPercent, fixed_cents: null } };
  }
  return { source: 'clinic_default', rule: { type: 'percent', percent: defaultPercent, fixed_cents: null } };
}

/** Comissão total do procedimento, quando tudo for recebido. */
export function commissionFor(baseCents, rule) {
  return rule.type === 'fixed' ? rule.fixed_cents : percentOf(baseCents, rule.percent);
}

/**
 * Quanto da comissão já está liberado.
 * - "procedure": tudo, desde que o procedimento foi realizado.
 * - "payment": proporcional ao que o paciente já pagou do orçamento (tirando a taxa do cartão, se a clínica desconta;
 *   a taxa só reduz comissões em percentual, valor fixo não muda).
 */
export function releasedCents(commission, rule, terms, { totalCents, paidByMethod }) {
  if (terms.releaseOn === 'procedure') return commission;
  if (totalCents <= 0) return 0;
  let paid = 0;
  for (const [method, amount] of Object.entries(paidByMethod)) {
    const fee = rule.type === 'percent' && terms.deductCardFees ? feePercent(terms, method) : 0;
    paid += amount - percentOf(amount, fee);
  }
  return Math.min(Math.round((commission * paid) / totalCents), commission);
}

function feePercent(terms, method) {
  if (method === 'credit_card') return terms.creditCardFeePercent;
  if (method === 'debit_card') return terms.debitCardFeePercent;
  return 0;
}
