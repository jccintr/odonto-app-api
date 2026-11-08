import { z } from '../../config/zod.js';
import { optionalText, uuidField } from '../../utils/fields.js';
import { paginationSchema } from '../../utils/pagination.js';
import { normalizeFaces, TEETH } from '../../utils/tooth.js';

export const toothField = z.number().int('Dente inválido (numeração FDI).').refine((n) => TEETH.includes(n), 'Dente inválido (numeração FDI).');
export const facesField = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[VLMDO]+$/, 'Faces inválidas (use V, L, M, D, O).')
  .transform(normalizeFaces);
export const centsField = z.number().int('O valor deve ser em centavos (número inteiro).').min(0, 'O valor não pode ser negativo.').max(100_000_000, 'Valor alto demais.');

export const STATUSES = ['open', 'approved', 'rejected', 'completed'];

const itemFields = {
  procedureId: uuidField,
  tooth: toothField.optional(),
  faces: facesField.optional(),
  priceCents: centsField.optional(),
};
const facesNeedTooth = { message: 'Informe o dente para indicar as faces.', path: ['faces'] };
const itemSchema = z.object(itemFields).refine((item) => !item.faces || item.tooth, facesNeedTooth);

export const listBudgetsQuery = z.object({
  ...paginationSchema,
  patientId: uuidField.optional(),
  dentistId: uuidField.optional(),
  status: z.enum(STATUSES, { error: 'Situação inválida.' }).optional(),
});

export const createBudgetSchema = z.object({
  patientId: uuidField,
  dentistId: uuidField.optional(),
  discountCents: centsField.default(0),
  notes: optionalText(2000, 'Observações').optional(),
  items: z.array(itemSchema).min(1, 'Inclua ao menos um procedimento.').max(100, 'Procedimentos demais em um orçamento.'),
});

export const updateBudgetSchema = z
  .object({ discountCents: centsField, notes: optionalText(2000, 'Observações').nullable() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');

export const addItemSchema = itemSchema;

export const updateItemSchema = z
  .object({ tooth: toothField.nullable(), faces: facesField.nullable(), priceCents: centsField })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');

// "completed" é automático (quando não resta item pendente), por isso não é aceito aqui
export const changeStatusSchema = z.object({ status: z.enum(['open', 'approved', 'rejected'], { error: 'Situação inválida.' }) });

// rodada de aprovação: quais itens o paciente aprovou agora e o desconto combinado para eles
export const approveItemsSchema = z.object({
  itemIds: z.array(uuidField).min(1, 'Escolha ao menos um procedimento.').max(100, 'Procedimentos demais.')
    .refine((ids) => new Set(ids).size === ids.length, 'Procedimento repetido.'),
  discountCents: centsField.default(0),
  notes: optionalText(500, 'Observações').optional(),
});

export const budgetParams = z.object({ id: uuidField });
export const itemParams = z.object({ id: uuidField, itemId: uuidField });
