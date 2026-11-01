import { z } from '../../config/zod.js';
import { optionalText } from '../../utils/fields.js';

export const listDentistsQuery = z.object({ active: z.enum(['true', 'false']).transform((v) => v === 'true').optional() });

export const updateDentistSchema = z
  .object({
    cro: optionalText(30, 'CRO').min(3, 'CRO inválido.').nullable(),
    specialty: optionalText(80, 'Especialidade').nullable(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor inválida (use #RRGGBB).'),
    payoutPercent: z.number().min(0, 'O percentual deve estar entre 0 e 100.').max(100, 'O percentual deve estar entre 0 e 100.').nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');
