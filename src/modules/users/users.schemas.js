import { z } from '../../config/zod.js';
import { emailField, passwordField } from '../auth/auth.schemas.js';
import { paginationSchema } from '../../utils/pagination.js';
import { phoneField } from '../../utils/fields.js';

export const ROLES = ['admin', 'secretary', 'dentist'];
const roleField = z.enum(ROLES, { error: 'Perfil inválido.' });
const nameField = z.string().trim().min(2, 'Informe o nome.').max(160, 'Nome muito longo.');

export const idParams = z.object({ id: z.uuid('Identificador inválido.') });

export const listQuery = z.object({
  ...paginationSchema,
  role: roleField.optional(),
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

// attendsPatients: o administrador também atende pacientes (ganha perfil clínico). Dentista sempre atende; secretária nunca.
const attendsField = z.boolean({ error: 'Informe true ou false.' });
// telefone da pessoa (DDD + número, aceita máscara); null apaga
export const teamPhoneField = phoneField.nullable();

export const createUserSchema = z.object({
  name: nameField,
  email: emailField,
  // senha inicial de quem ainda não tem conta; quem já tem conta (em outra clínica) recebe um convite e continua com a senha dele
  password: passwordField.optional(),
  role: roleField,
  phone: teamPhoneField.optional(),
  attendsPatients: attendsField.optional(),
});

export const updateUserSchema = z
  .object({ name: nameField, phone: teamPhoneField, role: roleField, active: z.boolean(), attendsPatients: attendsField })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');
