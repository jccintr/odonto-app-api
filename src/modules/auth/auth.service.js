import db from '../../db/knex.js';
import { config } from '../../config/env.js';
import { badRequest, emailNotVerified, forbidden, notFound, tooManyRequests, unauthorized } from '../../utils/errors.js';
import { toClinicDto, toUserDto } from '../../utils/dto.js';
import { loginThrottle } from '../../utils/loginThrottle.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../../services/password.js';
import { generateOpaqueToken, hashToken, signAccessToken } from '../../services/tokens.js';
import { sendInviteEmail, sendPasswordResetEmail, sendVerificationEmail } from '../../services/mailer.js';
import { findMember, membersQuery } from '../../services/members.js';
import { consumeAuthToken, cooldownRemaining, createAuthToken } from './auth.tokens.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const noClinicAccess = () => forbidden('Você não tem acesso a esta clínica.', { code: 'NO_CLINIC_ACCESS' });

/** O vínculo pode ser usado agora? (ativo, clínica ativa e e-mail da pessoa confirmado) */
const assertCanAccess = (member, clinic) => {
  if (!member.active) throw forbidden('Usuário desativado.', { code: 'USER_INACTIVE' });
  if (clinic.status !== 'active') throw forbidden('Clínica suspensa. Entre em contato com o suporte.', { code: 'CLINIC_SUSPENDED' });
  if (!member.email_verified_at) throw emailNotVerified();
};

/** Revoga os refresh tokens da pessoa em todas as clínicas (troca de senha ou reuso de token). trx é opcional. */
export const revokeAllUserTokens = (userId, trx = db) =>
  trx('refresh_tokens').where({ user_id: userId }).whereNull('revoked_at').update({ revoked_at: new Date() });

/**
 * Encerra só as sessões da pessoa numa clínica (o vínculo foi desativado; nas outras clínicas ela segue logada).
 * Os tokens EXPIRAM em vez de serem revogados: se o app da clínica tentar renovar com eles, não é reuso de token vazado,
 * então não pode derrubar as sessões da pessoa nas outras clínicas.
 */
export const revokeClinicSessions = (userId, clinicId, trx = db) =>
  trx('refresh_tokens').where({ user_id: userId, clinic_id: clinicId }).whereNull('revoked_at').where('expires_at', '>', new Date()).update({ expires_at: new Date() });

/** Cria a sessão de um vínculo: JWT de acesso (curto) + refresh token opaco (guardado só como hash). */
export async function issueSession(member, clinic) {
  const refreshToken = generateOpaqueToken();
  await db('refresh_tokens').insert({
    user_id: member.id,
    clinic_id: member.clinic_id,
    token_hash: hashToken(refreshToken),
    expires_at: new Date(Date.now() + config.refreshTokenDays * DAY_MS),
  });
  return { accessToken: signAccessToken(member), refreshToken, user: toUserDto(member), clinic: toClinicDto(clinic) };
}

/** Vínculos já aceitos da pessoa, com nome, slug e situação da clínica, em ordem de nome da clínica. */
const acceptedMemberships = (userId) =>
  membersQuery(db)
    .join('clinics', 'clinics.id', 'memberships.clinic_id')
    .where('memberships.user_id', userId)
    .whereNotNull('memberships.accepted_at')
    .select('clinics.name as clinic_name', 'clinics.slug as clinic_slug', 'clinics.status as clinic_status')
    .orderBy('clinics.name');

const isUsable = (member) => member.active && member.clinic_status === 'active';
const toClinicChoice = (member) => ({ id: member.clinic_id, name: member.clinic_name, slug: member.clinic_slug, role: member.role });
const clinicById = (id) => db('clinics').where({ id }).first();

/**
 * Entra com e-mail e senha. Quem tem vínculo com uma só clínica (ou informa `clinicId`) recebe a sessão direto;
 * quem pode entrar em mais de uma recebe a lista para escolher e repete o login com o `clinicId` escolhido.
 */
export async function login({ email, password, clinicId, ip }) {
  const key = `${ip}|${email}`;
  const wait = loginThrottle.blockedFor(key);
  if (wait > 0) throw tooManyRequests('Muitas tentativas de login. Tente novamente mais tarde.', wait);

  const user = await db('users').where({ email }).first();
  const passwordOk = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordOk) {
    loginThrottle.fail(key);
    throw unauthorized('E-mail ou senha inválidos.');
  }

  const memberships = await acceptedMemberships(user.id);
  let chosen;
  if (clinicId) {
    chosen = memberships.find((m) => m.clinic_id === clinicId);
    if (!chosen) throw noClinicAccess();
  } else {
    const usable = memberships.filter(isUsable);
    if (usable.length > 1) {
      if (!user.email_verified_at) throw emailNotVerified();
      loginThrottle.reset(key);
      return { clinicSelectionRequired: true, clinics: usable.map(toClinicChoice) };
    }
    // nenhuma ou uma clínica utilizável: sem nenhuma, o primeiro vínculo diz o motivo (desativado ou clínica suspensa)
    chosen = usable[0] ?? memberships[0];
    if (!chosen) {
      throw forbidden('Você ainda não tem acesso a nenhuma clínica. Se recebeu um convite por e-mail, aceite-o para entrar.', { code: 'NO_CLINIC_ACCESS' });
    }
  }

  assertCanAccess(chosen, { status: chosen.clinic_status });
  loginThrottle.reset(key);
  return issueSession(chosen, await clinicById(chosen.clinic_id));
}

/** Clínicas em que a pessoa pode entrar agora (para o seletor de clínica). */
export async function listMyClinics(userId) {
  return (await acceptedMemberships(userId)).filter(isUsable).map(toClinicChoice);
}

/** Troca a sessão para outra clínica da mesma pessoa (sem pedir a senha de novo). */
export async function switchClinic(auth, clinicId) {
  const member = await findMember(db, auth.userId, clinicId);
  if (!member?.accepted_at) throw noClinicAccess();
  const clinic = await clinicById(clinicId);
  assertCanAccess(member, clinic);
  return issueSession(member, clinic);
}

/**
 * Troca o refresh token por uma sessão nova (rotação). O token é gasto de forma atômica;
 * se um token já usado aparecer de novo, assume-se vazamento e todas as sessões da pessoa são encerradas.
 */
export async function refreshSession(refreshToken) {
  const tokenHash = hashToken(refreshToken);
  const now = new Date();
  const [claimed] = await db('refresh_tokens')
    .where({ token_hash: tokenHash })
    .whereNull('revoked_at')
    .where('expires_at', '>', now)
    .update({ revoked_at: now })
    .returning(['user_id', 'clinic_id']);

  if (!claimed) {
    const previous = await db('refresh_tokens').where({ token_hash: tokenHash }).first('user_id', 'revoked_at');
    if (previous?.revoked_at) await revokeAllUserTokens(previous.user_id);
    throw unauthorized('Sessão inválida ou expirada.');
  }

  const member = await findMember(db, claimed.user_id, claimed.clinic_id);
  if (!member?.accepted_at) throw unauthorized('Sessão inválida ou expirada.');
  const clinic = await clinicById(claimed.clinic_id);
  assertCanAccess(member, clinic);
  return issueSession(member, clinic);
}

export async function logout(refreshToken) {
  await db('refresh_tokens')
    .where({ token_hash: hashToken(refreshToken) })
    .whereNull('revoked_at')
    .update({ revoked_at: new Date() });
}

export async function getProfile(auth) {
  return { user: toUserDto(auth.user), clinic: toClinicDto(await clinicById(auth.clinicId)) };
}

/** A pessoa pode receber e-mails de acesso? (tem algum vínculo ativo, aceito ou convite, numa clínica ativa) */
async function hasOpenMembership(userId) {
  const row = await db('memberships')
    .join('clinics', 'clinics.id', 'memberships.clinic_id')
    .where({ 'memberships.user_id': userId, 'memberships.active': true, 'clinics.status': 'active' })
    .first('memberships.id');
  return Boolean(row);
}

// ---- verificação de e-mail ----

const verificationUrl = (token) => `${config.webUrl}/verificar-email?token=${token}`;

export async function sendVerification(user) {
  const hours = config.emailVerificationHours;
  const token = await createAuthToken(user.id, 'email_verification', hours * HOUR_MS);
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
 * exista o e-mail ou não: só envia para quem ainda não verificou, tem vínculo ativo numa clínica ativa e está fora do intervalo mínimo.
 */
export async function requestVerification(email) {
  const user = await db('users').where({ email }).first();
  if (!user || user.email_verified_at) return;
  if (!(await hasOpenMembership(user.id))) return;
  if ((await cooldownRemaining(user.id, 'email_verification')) > 0) return;
  await sendVerificationSafely(user);
}

const markVerified = (q, userId, now) =>
  q('users').where({ id: userId }).whereNull('email_verified_at').update({ email_verified_at: now, updated_at: now });

export async function verifyEmail(token) {
  const consumed = await consumeAuthToken(token, 'email_verification');
  if (!consumed) throw badRequest('Link inválido ou expirado.');
  await markVerified(db, consumed.user_id, new Date());
}

// ---- convites (pessoa que já tem conta entrando em outra clínica) ----

const inviteUrl = (token) => `${config.webUrl}/aceitar-convite?token=${token}`;

/** Envia o convite do vínculo pendente. Um convite novo da mesma clínica invalida o anterior; convites de outras clínicas continuam valendo. */
export async function sendInvite(member, clinic) {
  const days = config.inviteDays;
  const token = await createAuthToken(member.id, 'membership_invite', days * DAY_MS, clinic.id);
  await sendInviteEmail({ to: member.email, name: member.name, clinicName: clinic.name, role: member.role, url: inviteUrl(token), days });
}

export async function sendInviteSafely(member, clinic) {
  try {
    await sendInvite(member, clinic);
  } catch (err) {
    console.error('Falha ao enviar o convite:', err);
  }
}

/** Marca o vínculo pendente como aceito. Devolve a clínica (para o app mostrar e oferecer a troca) ou undefined se não há convite. */
async function acceptMembership(trx, userId, clinicId, now) {
  const [accepted] = await trx('memberships')
    .where({ user_id: userId, clinic_id: clinicId, active: true })
    .whereNull('accepted_at')
    .update({ accepted_at: now, updated_at: now })
    .returning('role');
  if (!accepted) return undefined;
  await trx('auth_tokens').where({ user_id: userId, clinic_id: clinicId, type: 'membership_invite' }).whereNull('used_at').update({ used_at: now });
  const clinic = await trx('clinics').where({ id: clinicId }).first('name', 'slug');
  return { id: clinicId, name: clinic.name, slug: clinic.slug, role: accepted.role };
}

const acceptedMessage = (clinic) => `Convite aceito! A ${clinic.name} já aparece para você ao entrar.`;

/** Aceite pelo link do e-mail (público: funciona mesmo para quem ainda não consegue entrar em nenhuma clínica). */
export async function acceptInviteByToken(token) {
  const consumed = await consumeAuthToken(token, 'membership_invite');
  if (!consumed) throw badRequest('Convite inválido ou expirado.');
  const now = new Date();
  const clinic = await db.transaction(async (trx) => {
    const accepted = await acceptMembership(trx, consumed.user_id, consumed.clinic_id, now);
    // quem abriu o link recebido por e-mail comprova o endereço
    if (accepted) await markVerified(trx, consumed.user_id, now);
    return accepted;
  });
  if (!clinic) throw badRequest('Este convite foi cancelado pela clínica.', { code: 'INVITE_CANCELED' });
  return { message: acceptedMessage(clinic), clinic };
}

/** Convites pendentes de quem está logado. */
export async function listInvitations(userId) {
  const rows = await db('memberships')
    .join('clinics', 'clinics.id', 'memberships.clinic_id')
    .where({ 'memberships.user_id': userId, 'memberships.active': true, 'clinics.status': 'active' })
    .whereNull('memberships.accepted_at')
    .orderBy('clinics.name')
    .select('clinics.id', 'clinics.name', 'clinics.slug', 'memberships.role', 'memberships.created_at');
  return rows.map((r) => ({ clinic: { id: r.id, name: r.name, slug: r.slug, role: r.role }, invitedAt: r.created_at }));
}

/** Aceite pelo app, por quem já está logado em outra clínica. */
export async function acceptInvitation(userId, clinicId) {
  const clinic = await db.transaction((trx) => acceptMembership(trx, userId, clinicId, new Date()));
  if (!clinic) throw notFound('Convite');
  return { message: acceptedMessage(clinic), clinic };
}

// ---- senha ----

/** Sempre responde igual, exista o e-mail ou não (não revela quem tem conta). Falhas de envio só vão para o log. */
export async function forgotPassword(email) {
  const user = await db('users').where({ email }).first();
  if (!user || !(await hasOpenMembership(user.id))) return;
  if ((await cooldownRemaining(user.id, 'password_reset')) > 0) return;

  try {
    const minutes = config.passwordResetMinutes;
    const token = await createAuthToken(user.id, 'password_reset', minutes * MINUTE_MS);
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

/** A senha é da pessoa: vale para todas as clínicas dela. As sessões em todas caem; quem trocou recebe uma nova na clínica atual. */
export async function changePassword({ auth, currentPassword, newPassword }) {
  if (!(await verifyPassword(currentPassword, auth.user.password_hash))) {
    throw badRequest('Senha atual incorreta.', { code: 'WRONG_PASSWORD' });
  }

  const now = new Date();
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (trx) => {
    await trx('users').where({ id: auth.userId }).update({ password_hash: passwordHash, password_changed_at: now, updated_at: now });
    await revokeAllUserTokens(auth.userId, trx);
  });
  return issueSession(await findMember(db, auth.userId, auth.clinicId), await clinicById(auth.clinicId));
}

/** Nome e telefone são da pessoa (valem em todas as clínicas): só ela altera os próprios quando trabalha em mais de uma. */
export async function updateMyProfile(auth, changes) {
  await db('users').where({ id: auth.userId }).update({ ...changes, updated_at: new Date() });
  return getProfile({ ...auth, user: await findMember(db, auth.userId, auth.clinicId) });
}
