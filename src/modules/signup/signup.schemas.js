import { z } from '../../config/zod.js';
import { emailField, passwordField } from '../auth/auth.schemas.js';
import { TEMPLATE_CODES } from './templates.js';

export const signupSchema = z.object({
  clinicName: z.string().trim().min(2, 'Informe o nome da clínica.').max(160, 'Nome muito longo.'),
  document: z.string().trim().max(20, 'Documento muito longo.').optional(),
  admin: z.object({
    name: z.string().trim().min(2, 'Informe seu nome.').max(160, 'Nome muito longo.'),
    email: emailField,
    password: passwordField,
  }),
  template: z.enum(TEMPLATE_CODES, { error: 'Escolha um modelo de clínica válido.' }).default('empty'),
  acceptTerms: z.literal(true, { error: 'É preciso aceitar os Termos de Uso e a Política de Privacidade.' }),
  captchaToken: z.string().min(1).max(4096).optional(),
});
