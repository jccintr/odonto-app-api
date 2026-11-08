import { z } from '../../config/zod.js';
import { optionalText, uuidField } from '../../utils/fields.js';

export const standingParams = z.object({ id: uuidField });

// exceção do administrador: motivo obrigatório e prazo curto (padrão: um dia, no máximo um mês)
export const releaseSchema = z.object({
  reason: optionalText(240, 'Motivo').min(3, 'Informe o motivo da liberação.'),
  days: z.number().int('Informe os dias em número inteiro.').min(1, 'No mínimo 1 dia.').max(30, 'No máximo 30 dias.').default(1),
});
