import { z } from '../../config/zod.js';

const monthField = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês inválido (use AAAA-MM).');

export const monthlyQuery = z.object({ month: monthField.optional() });
export const trendQuery = z.object({ month: monthField.optional(), months: z.coerce.number().int().min(1).max(12).default(6) });
