import { z } from '../../config/zod.js';
import { CONDITIONS } from '../../utils/tooth.js';
import { optionalText } from '../../utils/fields.js';
import { paginationSchema } from '../../utils/pagination.js';

const nameField = z.string().trim().min(2, 'Informe o nome.').max(160, 'Nome muito longo.');
const priceField = z.number().int('O valor deve ser em centavos (número inteiro).').min(0, 'O valor não pode ser negativo.').max(100_000_000, 'Valor alto demais.');

const conditionField = z.enum(CONDITIONS, { error: 'Condição do odontograma inválida.' });

export const listProceduresQuery = z.object({
  ...paginationSchema,
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

export const createProcedureSchema = z.object({
  name: nameField,
  category: optionalText(80, 'Categoria').nullable().optional(),
  priceCents: priceField.default(0),
  odontogramCondition: conditionField.nullable().optional(),
});

export const updateProcedureSchema = z
  .object({
    name: nameField,
    category: optionalText(80, 'Categoria').nullable(),
    priceCents: priceField,
    odontogramCondition: conditionField.nullable(),
    active: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');
