import db from '../../db/knex.js';
import { config } from '../../config/env.js';
import { badRequest, emailNotVerified, forbidden, tooManyRequests, unauthorized } from '../../utils/errors.js';
import { toClinicDto, toUserDto } from '../../utils/dto.js';
import { loginThrottle } from '../../utils/loginThrottle.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../../services/password.js';
import { generateOpaqueToken, hashToken, signAccessToken } from '../../services/tokens.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../../services/mailer.js';
import { consumeAuthToken, cooldownRemaining, createAuthToken } from './auth.tokens.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const assertCanAccess = (user, clinic) => {
  if (!user.active) throw forbidden('Usuário desativado.', { code: 'USER_INACTIVE' });
  if (clinic.status !== 'active') throw forbidden('Clínica suspensa. Entre em contato com o suporte.', { code: 'CLINIC_SUSPENDED' });
  if (!user.email_verified_at) throw emailNotVerified();
};

/** Revoga todos os refresh tokens do usuário (trocar a senha ou detectar reuso). trx é opcional. */
export const revokeAllUserTokens = (userId, trx = db) =>
  trx('refresh_tokens').where({ user_id: userId }).whereNull('revoked_at').update({ revoked_at: new Date() });

/** Cria a sessão: JWT de acesso (curto) + refresh token opaco (guardado só como hash). */
export async function issueSession(user, clinic) {
  const refreshToken = generateOpaqueToken();
  await db('refresh_tokens').insert({
    user_id: user.id,
    clinic_id: user.clinic_id,
    token_hash: hashToken(refreshToken),
    expires_at: new Date(Date.now() + config.refreshTokenDays * DAY_MS),
  });
  return { accessToken: signAccessToken(user), refreshToken, user: toUserDto(user), clinic: toClinicDto(clinic) };
}

export async function login({ email, password, ip }) {
  const key = `${ip}|${email}`;
  const wait = loginThrottle.blockedFor(key);
  if (wait > 0) throw tooManyRequests('Muitas tentativas de login. Tente novamente mais tarde.', wait);

  const user = await db('users').where({ email }).first();
  const passwordOk = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    loginThrottle.fail(key);
    throw unauthorized('E-mail ou senha inválidos.');
  }

  const clinic = await db('clinics').where({ id: user.clinic_id }).first();
  assertCanAccess(user, clinic);
  loginThrottle.reset(key);
  return issueSession(user, clinic);
}

/**
 * Troca o refresh token por uma sessão nova (rotação). O token é gasto de forma atômica;
 * se um token já usado aparecer de novo, assume-se vazamento e todas as sessões do usuário são encerradas.
 */
export async function refreshSession(refreshToken) {
  const tokenHash = hashToken(refreshToken);
  const now = new Date();
  const [claimed] = await db('refresh_tokens')
    .where({ token_hash: tokenHash })
    .whereNull('revoked_at')
    .where('expires_at', '>', now)
    .update({ revoked_at: now })
    .returning(['user_id']);

  if (!claimed) {
    const previous = await db('refresh_tokens').where({ token_hash: tokenHash }).first('user_id', 'revoked_at');
    if (previous?.revoked_at) await revokeAllUserTokens(previous.user_id);
    throw unauthorized('Sessão inválida ou expirada.');
  }

  const user = await db('users').where({ id: claimed.user_id }).first();
  const clinic = await db('clinics').where({ id: user.clinic_id }).first();
  assertCanAccess(user, clinic);
  return issueSession(user, clinic);
}

export async function logout(refreshToken) {
  await db('refresh_tokens')
    .where({ token_hash: hashToken(refreshToken) })
    .whereNull('revoked_at')
    .update({ revoked_at: new Date() });
}

export async function getProfile(userId) {
  const user = await db('users').where({ id: userId }).first();
  const clinic = await db('clinics').where({ id: user.clinic_id }).first();
  return { user: toUserDto(user), clinic: toClinicDto(clinic) };
}

// ---- verificação de e-mail ----

const verificationUrl = (token) => `${config.webUrl}/verificar-email?token=${token}`;

export async function sendVerification(user) {
  const hours = config.emailVerificationHours;
  const token = await createAuthToken(user, 'email_verification', hours * HOUR_MS);
  await sendVerificationEmail({ to: user.email, name: user.name, url: verificationUrl(token), hours });
}

/** Envia o e-mail de verificação sem derrubar quem chamou (cadastro de usuário/clínica não pode falhar por causa do SMTP). */
export async function sendVerificationSafely(user) {
  try {
    await sendVerification(user);
  } catch (err) {
    console.error('Falha ao enviar e-mail de verificação:', err);
  }
}

/**
 * Reenvia o link de verificação. Público (quem não verificou não consegue entrar) e, por isso, sempre responde igual,
 * exista o e-mail ou não: só envia para conta ativa, de clínica ativa, ainda não verificada e fora do intervalo mínimo.
 */
export async function requestVerification(email) {
  const user = await db('users').where({ email }).first();
  if (!user?.active || user.email_verified_at) return;
  const clinic = await db('clinics').where({ id: user.clinic_id }).first();
  if (clinic.status !== 'active') return;
  if ((await cooldownRemaining(user.id, 'email_verification')) > 0) return;
  await sendVerificationSafely(user);
}

export async function verifyEmail(token) {
  const consumed = await consumeAuthToken(token, 'email_verification');
  if (!consumed) throw badRequest('Link inválido ou expirado.');
  const now = new Date();
  await db('users').where({ id: consumed.user_id }).whereNull('email_verified_at').update({ email_verified_at: now, updated_at: now });
}

// ---- senha ----

/** Sempre responde igual, exista o e-mail ou não (não revela quem tem conta). Falhas de envio só vão para o log. */
export async function forgotPassword(email) {
  const user = await db('users').where({ email }).first();
  if (!user?.active) return;
  const clinic = await db('clinics').where({ id: user.clinic_id }).first();
  if (clinic.status !== 'active') return;
  if ((await cooldownRemaining(user.id, 'password_reset')) > 0) return;

  try {
    const minutes = config.passwordResetMinutes;
    const token = await createAuthToken(user, 'password_reset', minutes * MINUTE_MS);
    await sendPasswordResetEmail({
      to: user.email, name: user.name, url: `${config.webUrl}/redefinir-senha?token=${token}`, minutes,
    });
  } catch (err) {
    console.error('Falha ao enviar e-mail de redefinição de senha:', err);
  }
}

export async function resetPassword({ token, newPassword }) {
  const consumed = await consumeAuthToken(token, 'password_reset');
  if (!consumed) throw badRequest('Link inválido ou expirado.');

  const now = new Date();
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (trx) => {
    // quem recebeu o e-mail comprova o endereço: aproveita para marcar como verificado
    await trx('users').where({ id: consumed.user_id }).update({
      password_hash: passwordHash,
      password_changed_at: now,
      email_verified_at: trx.raw('COALESCE(email_verified_at, ?)', [now]),
      updated_at: now,
    });
    await revokeAllUserTokens(consumed.user_id, trx);
  });
}

export async function changePassword({ userId, currentPassword, newPassword }) {
  const user = await db('users').where({ id: userId }).first();
  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw badRequest('Senha atual incorreta.', { code: 'WRONG_PASSWORD' });
  }

  const now = new Date();
  const passwordHash = await hashPassword(newPassword);
  const [updated] = await db.transaction(async (trx) => {
    const rows = await trx('users').where({ id: userId }).update({ password_hash: passwordHash, password_changed_at: now, updated_at: now }).returning('*');
    await revokeAllUserTokens(userId, trx);
    return rows;
  });
  const clinic = await db('clinics').where({ id: updated.clinic_id }).first();
  // as sessões antigas caíram; devolve uma nova para quem acabou de trocar a senha continuar logado
  return issueSession(updated, clinic);
}
