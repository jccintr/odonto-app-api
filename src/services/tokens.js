import crypto from 'node:crypto';
import jsonwebtoken from 'jsonwebtoken';
import { config } from '../config/env.js';

// ---- JWT de acesso (curta duração) ----
export const signAccessToken = (user) =>
  jsonwebtoken.sign({ cid: user.clinic_id, role: user.role }, config.jwtSecret, {
    subject: user.id,
    expiresIn: config.accessTokenTtl,
  });

export const verifyAccessToken = (token) => jsonwebtoken.verify(token, config.jwtSecret);

// ---- JWT da plataforma (segredo próprio) ----
export const signPlatformToken = (admin) =>
  jsonwebtoken.sign({ scope: 'platform' }, config.platformJwtSecret, {
    subject: admin.id,
    expiresIn: config.platformTokenTtl,
  });

export const verifyPlatformToken = (token) => jsonwebtoken.verify(token, config.platformJwtSecret);

// ---- tokens opacos (refresh, verificação de e-mail, troca de senha) ----
// Valor aleatório de 256 bits entregue ao usuário; no banco fica só o SHA-256 (o valor tem entropia alta, não precisa de bcrypt).
export const generateOpaqueToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
