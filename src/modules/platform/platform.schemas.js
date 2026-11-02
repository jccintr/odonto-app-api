import { z } from '../../config/zod.js';
import { emailField, passwordField } from '../auth/auth.schemas.js';
import { paginationSchema } from '../../utils/pagination.js';
import { BILLING_STATES } from '../billing/access.js';
import { isoDate } from '../../utils/fields.js';

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
  billing: z.enum(BILLING_STATES, { error: 'Situação da assinatura inválida.' }).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

// ---- cobrança ----
const optionalNote = z.string().trim().max(255, 'Observação muito longa.').optional();

export const invoiceParams = z.object({ id: z.uuid('Identificador inválido.'), invoiceId: z.uuid('Identificador inválido.') });
export const payInvoiceSchema = z.object({ note: optionalNote });
export const extendTrialSchema = z.object({ days: z.number().int('Informe dias inteiros.').min(1, 'Mínimo de 1 dia.').max(365, 'Máximo de 365 dias.') });
export const courtesySchema = z
  .object({
    indefinite: z.boolean().default(false),
    until: isoDate.nullable().default(null),
  });
export const listInvoicesQuery = z.object({
  ...paginationSchema,
  status: z.enum(['OPEN', 'PAID', 'VOID'], { error: 'Situação inválida.' }).optional(),
  reported: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
export const updatePlanSchema = z
  .object({
    name: nameField,
    description: z.string().trim().max(255, 'Descrição muito longa.').nullable(),
    priceCents: z.number().int('O valor deve ser em centavos (número inteiro).').min(100, 'O mínimo é R$ 1,00.').max(100_000_00, 'Valor alto demais.'),
    maxDentists: z.number().int('Informe um número inteiro.').min(1, 'O mínimo é 1 dentista.').max(1000).nullable(),
    active: z.boolean(),
    position: z.number().int().min(0).max(100),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');
