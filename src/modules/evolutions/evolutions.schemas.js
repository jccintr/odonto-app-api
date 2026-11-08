import { z } from '../../config/zod.js';
import { uuidField } from '../../utils/fields.js';
import { paginationSchema } from '../../utils/pagination.js';
import { toothField } from '../budgets/budgets.schemas.js';

const text = z.string().trim().min(3, 'Descreva o que foi feito (mínimo de 3 letras).').max(5000, 'Texto muito longo.');

// onde o procedimento foi feito: os dentes afetados (FDI) ou a boca toda
const teethField = z.array(toothField).min(1, 'Informe os dentes afetados.').max(32).transform((list) => [...new Set(list)]);
const where = { teeth: teethField.optional(), wholeMouth: z.literal(true).optional() };
const onlyOneWhere = (x) => !(x.teeth && x.wholeMouth);
const WHERE_ONCE = { message: 'Informe os dentes afetados ou marque boca toda, não os dois.', path: ['teeth'] };
const WHERE_REQUIRED = { message: 'Informe os dentes afetados ou marque boca toda.', path: ['teeth'] };

// o que foi feito: procedimento(s) e onde (obrigatório), mais um texto opcional. Item de orçamento que já tem dente usa o dele.
export const evolutionInput = z
  .object({
    description: text.optional(),
    procedures: z.array(z.object({ procedureId: uuidField, ...where }).refine(onlyOneWhere, WHERE_ONCE).refine((x) => x.teeth || x.wholeMouth, WHERE_REQUIRED)).max(30).default([]),
    budgetItems: z.array(z.object({ itemId: uuidField, ...where }).refine(onlyOneWhere, WHERE_ONCE)).max(30).default([]),
  })
  .refine((e) => e.procedures.length > 0 || e.budgetItems.length > 0, {
    message: 'Informe o procedimento realizado e os dentes afetados.',
    path: ['procedures'],
  });

export const patientParams = z.object({ patientId: uuidField });
export const evolutionParams = z.object({ patientId: uuidField, id: uuidField });
export const listEvolutionsQuery = z.object({ ...paginationSchema });
export const addendumSchema = z.object({ description: text });
