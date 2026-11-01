// Tokens de uso único (verificação de e-mail e troca de senha). No banco fica só o hash do token.
import db from '../../db/knex.js';
import { config } from '../../config/env.js';
import { generateOpaqueToken, hashToken } from '../../services/tokens.js';

/** Cria um token novo e invalida os anteriores não usados do mesmo tipo. Devolve o valor em texto (só existe aqui). */
export async function createAuthToken(user, type, ttlMs) {
  const now = new Date();
  await db('auth_tokens').where({ user_id: user.id, type }).whereNull('used_at').update({ used_at: now });
  const token = generateOpaqueToken();
  await db('auth_tokens').insert({
    user_id: user.id,
    clinic_id: user.clinic_id,
    type,
    token_hash: hashToken(token),
    expires_at: new Date(now.getTime() + ttlMs),
  });
  return token;
}

/** Gasta o token de forma atômica. Devolve { user_id, clinic_id } ou undefined se inválido, usado ou expirado. */
export async function consumeAuthToken(token, type) {
  const [row] = await db('auth_tokens')
    .where({ token_hash: hashToken(token), type })
    .whereNull('used_at')
    .where('expires_at', '>', new Date())
    .update({ used_at: new Date() })
    .returning(['user_id', 'clinic_id']);
  return row;
}

/** Segundos que faltam para poder pedir outro token do tipo (0 = liberado). */
export async function cooldownRemaining(userId, type) {
  const last = await db('auth_tokens').where({ user_id: userId, type }).orderBy('created_at', 'desc').first('created_at');
  if (!last) return 0;
  const waitMs = config.tokenResendCooldownSeconds * 1000 - (Date.now() - last.created_at.getTime());
  return Math.max(0, Math.ceil(waitMs / 1000));
}
