import { z } from '../../config/zod.js';

export const updateClinicSchema = z
  .object({
    name: z.string().trim().min(2, 'Informe o nome.').max(160, 'Nome muito longo.'),
    document: z.string().trim().max(20, 'Documento muito longo.').nullable(),
    cashDiscountPercent: z.number().int('Informe o percentual em número inteiro.').min(0, 'Não pode ser negativo.').max(50, 'No máximo 50%.'),
    overdueGraceDays: z.number().int('Informe os dias em número inteiro.').min(0, 'Não pode ser negativo.').max(60, 'No máximo 60 dias.'),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');
