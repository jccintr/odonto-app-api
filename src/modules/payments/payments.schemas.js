import { z } from '../../config/zod.js';
import { isoDate, isoDateTime, optionalText, uuidField } from '../../utils/fields.js';
import { paginationSchema } from '../../utils/pagination.js';
import { PAYMENT_METHODS, PAYMENT_STATUSES } from '../../utils/payments.js';

const amountField = z.number().int('O valor deve ser em centavos (número inteiro).').min(1, 'O valor deve ser maior que zero.').max(100_000_000, 'Valor alto demais.');
const methodField = z.enum(PAYMENT_METHODS, { error: 'Forma de pagamento inválida.' });
const notesField = optionalText(500, 'Observações');
const approvalField = uuidField; // rodada de aprovação; opcional quando o orçamento tem uma só

// Já recebido (paidAt + method) ou a receber (dueDate). Misturar os dois não faz sentido.
export const createPaymentSchema = z
  .object({ amountCents: amountField, approvalId: approvalField.optional(), dueDate: isoDate.optional(), method: methodField.optional(), paidAt: isoDateTime.optional(), notes: notesField.optional() })
  .superRefine((body, ctx) => {
    if (body.paidAt) {
      if (!body.method) ctx.addIssue({ code: 'custom', path: ['method'], message: 'Informe a forma de pagamento.' });
    } else {
      if (!body.dueDate) ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'Informe o vencimento.' });
      if (body.method) ctx.addIssue({ code: 'custom', path: ['method'], message: 'A forma de pagamento só vale para pagamentos já recebidos.' });
    }
  });

export const planSchema = z.object({
  installments: z.number().int('Número de parcelas inválido.').min(1, 'Informe ao menos 1 parcela.').max(48, 'No máximo 48 parcelas.'),
  firstDueDate: isoDate,
  amountCents: amountField.optional(),
  approvalId: approvalField.optional(),
});

export const updatePaymentSchema = z
  .object({ amountCents: amountField, dueDate: isoDate, notes: notesField.nullable() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');

export const paySchema = z.object({ method: methodField, paidAt: isoDateTime.optional() });
export const cancelSchema = z.object({ reason: optionalText(240, 'Motivo').optional() });

export const listPaymentsQuery = z.object({
  ...paginationSchema,
  status: z.enum(PAYMENT_STATUSES, { error: 'Situação inválida.' }).optional(),
  method: methodField.optional(),
  patientId: uuidField.optional(),
  budgetId: uuidField.optional(),
  dueFrom: isoDate.optional(),
  dueTo: isoDate.optional(),
  overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
