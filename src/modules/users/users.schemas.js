import { z } from '../../config/zod.js';
import { emailField, passwordField } from '../auth/auth.schemas.js';
import { paginationSchema } from '../../utils/pagination.js';

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

export const createUserSchema = z.object({
  name: nameField,
  email: emailField,
  password: passwordField,
  role: roleField,
});

export const updateUserSchema = z
  .object({ name: nameField, role: roleField, active: z.boolean() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');
