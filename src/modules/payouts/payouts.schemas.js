import { z } from '../../config/zod.js';
import { isoDate, isoDateTime, optionalText, uuidField } from '../../utils/fields.js';
import { paginationSchema } from '../../utils/pagination.js';
import { PAYMENT_METHODS } from '../../utils/payments.js';
import { PAYOUT_RELEASE_MODES, PAYOUT_RULE_TYPES, PAYOUT_STATUSES } from '../../utils/payouts.js';

// percentual de 0 a 100 com até 2 casas decimais (o banco guarda 2)
const percentField = z
  .number()
  .min(0, 'O percentual deve estar entre 0 e 100.')
  .max(100, 'O percentual deve estar entre 0 e 100.')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Use no máximo 2 casas decimais.');
const fixedField = z.number().int('O valor deve ser em centavos (número inteiro).').min(0, 'O valor não pode ser negativo.').max(100_000_000, 'Valor alto demais.');

export const updateSettingsSchema = z
  .object({
    releaseOn: z.enum(PAYOUT_RELEASE_MODES, { error: 'Momento de liberação inválido.' }),
    deductCosts: z.boolean(),
    deductCardFees: z.boolean(),
    creditCardFeePercent: percentField,
    debitCardFeePercent: percentField,
    defaultPercent: percentField,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');

// o tipo define qual valor vale: percentual ou valor fixo em centavos (por procedimento realizado)
const ruleValue = z
  .object({ type: z.enum(PAYOUT_RULE_TYPES, { error: 'Tipo de regra inválido.' }), percent: percentField.optional(), fixedCents: fixedField.optional() })
  .superRefine((body, ctx) => {
    if (body.type === 'percent') {
      if (body.percent === undefined) ctx.addIssue({ code: 'custom', path: ['percent'], message: 'Informe o percentual.' });
      if (body.fixedCents !== undefined) ctx.addIssue({ code: 'custom', path: ['fixedCents'], message: 'O valor fixo não vale para regra em percentual.' });
    } else {
      if (body.fixedCents === undefined) ctx.addIssue({ code: 'custom', path: ['fixedCents'], message: 'Informe o valor fixo.' });
      if (body.percent !== undefined) ctx.addIssue({ code: 'custom', path: ['percent'], message: 'O percentual não vale para regra em valor fixo.' });
    }
  });

export const updateRuleSchema = ruleValue;
export const createRuleSchema = ruleValue.safeExtend({ procedureId: uuidField, dentistId: uuidField.optional() });

export const listRulesQuery = z.object({ procedureId: uuidField.optional(), dentistId: uuidField.optional() });
export const resolveRuleQuery = z.object({ dentistId: uuidField, procedureId: uuidField });

export const listEntriesQuery = z.object({
  ...paginationSchema,
  dentistId: uuidField.optional(),
  budgetId: uuidField.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  until: isoDate.optional(),
});
export const balancesQuery = z.object({ until: isoDate.optional() });

export const createPayoutSchema = z.object({
  dentistId: uuidField,
  until: isoDate.optional(),
  method: z.enum(PAYMENT_METHODS, { error: 'Forma de pagamento inválida.' }),
  paidAt: isoDateTime.optional(),
  notes: optionalText(500, 'Observações').optional(),
});
export const listPayoutsQuery = z.object({
  ...paginationSchema,
  dentistId: uuidField.optional(),
  status: z.enum(PAYOUT_STATUSES, { error: 'Situação inválida.' }).optional(),
});
export const cancelPayoutSchema = z.object({ reason: optionalText(240, 'Motivo').optional() });
