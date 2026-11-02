// Pix da cobrança: a chave é a do dono da plataforma (variáveis BILLING_PIX_*). Não há gateway; quem confirma é o dono.
import { config } from '../../config/env.js';
import { buildPixPayload, normalizePixKey } from '../../utils/pix.js';

/**
 * Dados para pagar uma fatura: chave, "copia e cola" e instruções. null = a plataforma não configurou o Pix.
 * Chave que não dá para entender (ou que é CPF e telefone ao mesmo tempo, sem BILLING_PIX_KEY_TYPE) vem sem `payload`, com o motivo em `reason`.
 */
export function pixFor(invoice) {
  const key = config.billingPixKey;
  if (!key) return null;
  const base = { beneficiary: config.billingPixBeneficiary, instructions: config.billingPixInstructions || null };
  const norm = normalizePixKey(key, config.billingPixKeyType);
  if (!norm.ok) return { ...base, key, payload: null, reason: norm.code };
  const payload = buildPixPayload({
    key: norm.key, name: config.billingPixBeneficiary, city: config.billingPixCity, amountCents: invoice.amount_cents, txid: `ODT${invoice.id}`,
  });
  return { ...base, key: norm.key, payload, reason: null };
}
