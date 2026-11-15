import db from '../db/knex.js';
import { HttpError, emailNotVerified, forbidden, unauthorized } from '../utils/errors.js';
import { businessDate } from '../utils/dates.js';
import { computeAccess, isOpenWhenSuspended } from '../modules/billing/access.js';
import { issuedBeforePasswordChange } from '../utils/session.js';
import { verifyAccessToken, verifyPlatformToken } from '../services/tokens.js';
import { membersQuery } from '../services/members.js';

const bearerToken = (req) => {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();
  return token;
};

const decode = (verify, token) => {
  try {
    return verify(token);
  } catch {
    throw unauthorized();
  }
};

/**
 * Valida o JWT da clínica e confere que a pessoa, o vínculo com a clínica e a clínica continuam ativos. Preenche req.auth:
 * userId (a pessoa), clinicId, role (perfil NESTA clínica) e dentistId (perfil clínico ativo nesta clínica, ou null).
 */
export const authenticate = async (req, res, next) => {
  const payload = decode(verifyAccessToken, bearerToken(req));
  const member = await membersQuery(db)
    .join('clinics', 'clinics.id', 'memberships.clinic_id')
    .join('subscriptions', 'subscriptions.clinic_id', 'memberships.clinic_id')
    .where({ 'memberships.user_id': payload.sub, 'memberships.clinic_id': payload.cid })
    .first('clinics.status as clinic_status', 'subscriptions.trial_ends_on', 'subscriptions.paid_until', 'subscriptions.courtesy_until', 'subscriptions.courtesy_indefinite');

  if (!member || !member.active || !member.accepted_at) throw unauthorized();
  if (issuedBeforePasswordChange(member.password_changed_at, payload.iat)) throw unauthorized();
  if (member.clinic_status !== 'active') throw forbidden('Clínica suspensa. Entre em contato com o suporte.', { code: 'CLINIC_SUSPENDED' });

  if (!member.email_verified_at) throw emailNotVerified();

  // assinatura suspensa: o painel fica restrito à tela de assinatura e à exportação dos dados (a conta continua sendo da clínica)
  const billing = computeAccess(member, businessDate());
  if (billing.blocked && !isOpenWhenSuspended(req.method, req.originalUrl.split('?')[0])) {
    throw new HttpError(402, 'Assinatura suspensa. Regularize o pagamento na tela Assinatura para voltar a usar o sistema.', { code: 'SUBSCRIPTION_SUSPENDED' });
  }

  req.auth = {
    userId: member.id, clinicId: member.clinic_id, membershipId: member.membership_id, role: member.role, dentistId: member.dentist_id, user: member, billing,
  };
  next();
};

/** Exige um dos perfis informados (use depois de authenticate). */
export const requireRole = (...roles) => {
  const middleware = (req, res, next) => {
    if (!roles.includes(req.auth.role)) throw forbidden();
    next();
  };
  middleware.roles = roles; // lido pelo gerador da documentação (src/docs)
  return middleware;
};

/**
 * Exige quem atende pacientes nesta clínica: o perfil dentista ou o administrador que também atende (tem perfil clínico ativo).
 * Para a documentação e a matriz de segurança, o perfil é `dentist` (com a observação sobre o administrador que atende).
 */
export const requireClinicalProfile = (req, res, next) => {
  if (!req.auth.dentistId) throw forbidden();
  next();
};
requireClinicalProfile.roles = ['dentist'];
requireClinicalProfile.attendingAdmin = true;

/** Valida o JWT da plataforma (segredo próprio). Preenche req.platformAdmin. */
export const authenticatePlatform = async (req, res, next) => {
  const payload = decode(verifyPlatformToken, bearerToken(req));
  const admin = await db('platform_admins').where({ id: payload.sub }).first();
  if (!admin || !admin.active) throw unauthorized();
  if (issuedBeforePasswordChange(admin.password_changed_at, payload.iat)) throw unauthorized();
  req.platformAdmin = admin;
  next();
};
