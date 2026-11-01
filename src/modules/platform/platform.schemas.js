import { z } from '../../config/zod.js';
import { emailField, passwordField } from '../auth/auth.schemas.js';
import { paginationSchema } from '../../utils/pagination.js';

export const platformLoginSchema = z.object({ email: emailField, password: z.string().min(1, 'Informe a senha.') });
export const idParams = z.object({ id: z.uuid('Identificador inválido.') });

const nameField = z.string().trim().min(2, 'Informe o nome.').max(160, 'Nome muito longo.');
const slugField = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug inválido (use letras minúsculas, números e hífens).').max(80);
const statusField = z.enum(['active', 'suspended'], { error: 'Situação inválida.' });

export const createClinicSchema = z.object({
  name: nameField,
  slug: slugField.optional(),
  document: z.string().trim().max(20, 'Documento muito longo.').optional(),
  plan: z.string().trim().min(1).max(40).optional(),
  admin: z.object({ name: nameField, email: emailField, password: passwordField }),
});

export const updateClinicSchema = z
  .object({
    name: nameField,
    document: z.string().trim().max(20, 'Documento muito longo.').nullable(),
    plan: z.string().trim().min(1).max(40),
    status: statusField,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');

export const listClinicsQuery = z.object({
  ...paginationSchema,
  status: statusField.optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
