import { z } from '../../config/zod.js';
import { optionalText, uuidField } from '../../utils/fields.js';
import { paginationSchema } from '../../utils/pagination.js';
import { NOTIFICATION_KINDS, NOTIFICATION_STATUSES } from '../../utils/notifications.js';

export const appointmentParams = z.object({ appointmentId: uuidField });
export const budgetParams = z.object({ budgetId: uuidField });

export const updateSettingsSchema = z
  .object({
    remindersEnabled: z.boolean(),
    reminderHoursBefore: z.number().int('Informe um número inteiro de horas.').min(1, 'No mínimo 1 hora.').max(72, 'No máximo 72 horas.'),
    contactPhone: optionalText(20, 'Telefone').nullable(),
    contactAddress: optionalText(240, 'Endereço').nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');

export const listNotificationsQuery = z.object({
  ...paginationSchema,
  patientId: uuidField.optional(),
  kind: z.enum(NOTIFICATION_KINDS, { error: 'Tipo inválido.' }).optional(),
  status: z.enum(NOTIFICATION_STATUSES, { error: 'Situação inválida.' }).optional(),
});
