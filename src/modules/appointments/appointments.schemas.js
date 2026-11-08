import { z } from '../../config/zod.js';
import { isoDateTime, optionalText, uuidField } from '../../utils/fields.js';
import { paginationSchema } from '../../utils/pagination.js';
import { evolutionInput } from '../evolutions/evolutions.schemas.js';

export const STATUSES = ['scheduled', 'confirmed', 'in_progress', 'attended', 'no_show', 'canceled'];
const statusField = z.enum(STATUSES, { error: 'Situação inválida.' });

export const listAppointmentsQuery = z.object({
  ...paginationSchema,
  perPage: z.coerce.number().int().min(1).max(200).default(100),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  dentistId: uuidField.optional(),
  patientId: uuidField.optional(),
  status: statusField.optional(),
});

export const createAppointmentSchema = z
  .object({
    patientId: uuidField,
    dentistId: uuidField.optional(),
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    notes: optionalText(2000, 'Observações').optional(),
  })
  .refine((body) => new Date(body.endsAt) > new Date(body.startsAt), { message: 'O término deve ser depois do início.', path: ['endsAt'] });

export const updateAppointmentSchema = z
  .object({
    dentistId: uuidField,
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    notes: optionalText(2000, 'Observações').nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');

export const changeStatusSchema = z
  .object({
    status: statusField,
    reason: optionalText(240, 'Motivo').optional(),
    evolution: evolutionInput.optional(),
  })
  // marcar como atendido exige registrar o que foi feito; nas demais situações não há evolução
  .refine((body) => body.status !== 'attended' || body.evolution, { message: 'Informe o que foi feito no atendimento.', path: ['evolution'] })
  .refine((body) => body.status === 'attended' || !body.evolution, { message: 'A evolução só vale ao marcar como atendido.', path: ['evolution'] });
