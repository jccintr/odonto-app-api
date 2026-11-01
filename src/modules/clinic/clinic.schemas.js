import { z } from '../../config/zod.js';

export const updateClinicSchema = z
  .object({
    name: z.string().trim().min(2, 'Informe o nome.').max(160, 'Nome muito longo.'),
    document: z.string().trim().max(20, 'Documento muito longo.').nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');
