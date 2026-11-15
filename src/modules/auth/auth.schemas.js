import { z } from '../../config/zod.js';
import { phoneField } from '../../utils/fields.js';

export const emailField = z.string().trim().toLowerCase().pipe(z.email('E-mail inválido.'));

export const passwordField = z
  .string()
  .min(8, 'A senha deve ter ao menos 8 caracteres.')
  .max(72, 'A senha deve ter no máximo 72 caracteres.');

export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, 'Informe a senha.'),
  clinicId: z.uuid('Clínica inválida.').optional(),
});
export const switchClinicSchema = z.object({ clinicId: z.uuid('Clínica inválida.') });
export const clinicParams = z.object({ clinicId: z.uuid('Clínica inválida.') });
export const updateMeSchema = z
  .object({ name: z.string().trim().min(2, 'Informe o nome.').max(160, 'Nome muito longo.'), phone: phoneField.nullable() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Informe ao menos um campo para alterar.');
export const refreshSchema = z.object({ refreshToken: z.string().min(1, 'Informe o refreshToken.') });
export const tokenSchema = z.object({ token: z.string().min(1, 'Informe o token.') });
export const forgotPasswordSchema = z.object({ email: emailField });
export const resetPasswordSchema = z.object({ token: z.string().min(1, 'Informe o token.'), newPassword: passwordField });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1, 'Informe a senha atual.'), newPassword: passwordField });
