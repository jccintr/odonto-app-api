import { z } from '../../config/zod.js';

export const idParams = z.object({ id: z.uuid('Identificador inválido.') });
export const choosePlanSchema = z.object({ planId: z.uuid('Plano inválido.') });
export const reportPaidSchema = z.object({ note: z.string().trim().max(255, 'Observação muito longa.').optional() });
