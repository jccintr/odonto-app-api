import db from '../db/knex.js';
import { emailNotVerified, forbidden, unauthorized } from '../utils/errors.js';
import { issuedBeforePasswordChange } from '../utils/session.js';
import { verifyAccessToken, verifyPlatformToken } from '../services/tokens.js';

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

/** Valida o JWT da clínica e confere que usuário e clínica continuam ativos. Preenche req.auth. */
export const authenticate = async (req, res, next) => {
  const payload = decode(verifyAccessToken, bearerToken(req));
  const user = await db('users')
    .join('clinics', 'clinics.id', 'users.clinic_id')
    .where('users.id', payload.sub)
    .first('users.*', 'clinics.status as clinic_status');

  if (!user || !user.active) throw unauthorized();
  if (issuedBeforePasswordChange(user.password_changed_at, payload.iat)) throw unauthorized();
  if (user.clinic_status !== 'active') throw forbidden('Clínica suspensa. Entre em contato com o suporte.', { code: 'CLINIC_SUSPENDED' });

  if (!user.email_verified_at) throw emailNotVerified();

  req.auth = { userId: user.id, clinicId: user.clinic_id, role: user.role, user };
  next();
};

/** Exige um dos perfis informados (use depois de authenticate). */
export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.auth.role)) throw forbidden();
  next();
};

/** Valida o JWT da plataforma (segredo próprio). Preenche req.platformAdmin. */
export const authenticatePlatform = async (req, res, next) => {
  const payload = decode(verifyPlatformToken, bearerToken(req));
  const admin = await db('platform_admins').where({ id: payload.sub }).first();
  if (!admin || !admin.active) throw unauthorized();
  if (issuedBeforePasswordChange(admin.password_changed_at, payload.iat)) throw unauthorized();
  req.platformAdmin = admin;
  next();
};
