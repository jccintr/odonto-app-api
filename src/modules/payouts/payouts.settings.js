import { recordAudit } from '../../services/audit.js';
import { withTenant } from '../../db/tenant.js';

export const DEFAULT_SETTINGS = {
  release_on: 'payment', deduct_costs: false, deduct_card_fees: false,
  credit_card_fee_percent: 0, debit_card_fee_percent: 0, default_percent: 0,
};

const COLUMN = {
  releaseOn: 'release_on', deductCosts: 'deduct_costs', deductCardFees: 'deduct_card_fees',
  creditCardFeePercent: 'credit_card_fee_percent', debitCardFeePercent: 'debit_card_fee_percent', defaultPercent: 'default_percent',
};
const toColumns = (input) => Object.fromEntries(Object.entries(input).map(([key, value]) => [COLUMN[key], value]));

/** Configuração da clínica (RLS limita a consulta à clínica da transação); sem linha salva, valem os padrões. */
export async function loadSettings(trx) {
  return (await trx('payout_settings').first()) ?? DEFAULT_SETTINGS;
}

/** Parte da configuração que o lançamento congela para sempre. */
export const termsOf = (s) => ({
  releaseOn: s.release_on,
  deductCardFees: s.deduct_card_fees,
  creditCardFeePercent: Number(s.credit_card_fee_percent),
  debitCardFeePercent: Number(s.debit_card_fee_percent),
});

export const toSettingsDto = (s) => ({
  releaseOn: s.release_on,
  deductCosts: s.deduct_costs,
  deductCardFees: s.deduct_card_fees,
  creditCardFeePercent: Number(s.credit_card_fee_percent),
  debitCardFeePercent: Number(s.debit_card_fee_percent),
  defaultPercent: Number(s.default_percent),
});

export function getSettings(clinicId) {
  return withTenant(clinicId, async (trx) => toSettingsDto(await loadSettings(trx)));
}

export function updateSettings(auth, changes) {
  return withTenant(auth.clinicId, async (trx) => {
    const columns = toColumns(changes);
    const [row] = await trx('payout_settings')
      .insert({ clinic_id: auth.clinicId, ...columns })
      .onConflict('clinic_id')
      .merge({ ...columns, updated_at: new Date() })
      .returning('*');
    await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'payout_settings', entityId: auth.clinicId, action: 'update', changes: { fields: Object.keys(changes) } });
    return toSettingsDto(row);
  });
}
