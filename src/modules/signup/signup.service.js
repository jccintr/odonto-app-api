// Cadastro público de clínicas (autoatendimento): cria a clínica em período de teste e avisa o dono da plataforma.
import { config } from '../../config/env.js';
import { badRequest, forbidden } from '../../utils/errors.js';
import { toPlanDto } from '../../utils/dto.js';
import db from '../../db/knex.js';
import { turnstileEnabled, verifyTurnstile } from '../../services/turnstile.js';
import { notifyOwner } from '../billing/notify.js';
import { provisionClinic } from '../clinic/provision.js';
import { LEGAL_VERSION } from '../legal/documents.js';
import { isBlockedEmail } from './disposable.js';
import { TEMPLATES } from './templates.js';

/** Tudo que a tela de cadastro precisa mostrar: modelos, planos e preços, duração do teste e se há captcha. */
export async function getOptions() {
  const plans = await db('plans').where({ active: true }).orderBy('position');
  return {
    signupEnabled: config.signupEnabled,
    trialDays: config.trialDays,
    legalVersion: LEGAL_VERSION,
    captchaRequired: turnstileEnabled(),
    templates: TEMPLATES.map((t) => ({ code: t.code, name: t.name, description: t.description, procedureCount: t.procedures.length })),
    plans: plans.map(toPlanDto),
  };
}

export async function signup(body, { ip, userAgent }) {
  if (!config.signupEnabled) throw forbidden('O cadastro de novas clínicas está desativado no momento.', { code: 'SIGNUP_DISABLED' });
  if (isBlockedEmail(body.admin.email)) {
    throw badRequest('Este e-mail temporário não é aceito. Use o e-mail que você realmente utiliza.', { code: 'EMAIL_NOT_ALLOWED' });
  }
  if (turnstileEnabled()) {
    if (!body.captchaToken) throw badRequest('Confirme que você não é um robô.', { code: 'CAPTCHA_REQUIRED' });
    if (!(await verifyTurnstile(body.captchaToken, ip))) throw badRequest('Não foi possível validar a verificação anti-robô. Tente novamente.', { code: 'CAPTCHA_FAILED' });
  }

  const result = await provisionClinic({
    name: body.clinicName,
    document: body.document,
    admin: body.admin,
    templateCode: body.template,
    acceptance: { termsVersion: LEGAL_VERSION, privacyVersion: LEGAL_VERSION, ip, userAgent },
  });
  await notifyOwner('Nova clínica cadastrada', [
    `Clínica: ${result.clinic.name}`, `Administrador: ${result.admin.name} <${result.admin.email}>`, `Modelo: ${body.template}`, `Teste até: ${result.trialEndsOn}`,
  ]);
  return { ...result, message: 'Clínica criada! Enviamos um link de confirmação para o seu e-mail. Confirme para entrar.' };
}
