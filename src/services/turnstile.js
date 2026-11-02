// Cloudflare Turnstile (captcha sem enigma), opcional: só vale se TURNSTILE_SECRET estiver configurada.
import { config } from '../config/env.js';

export const turnstileEnabled = () => Boolean(config.turnstileSecret);

/** true se o token foi aprovado pela Cloudflare. Falha de rede conta como reprovado (nunca deixa passar por engano). */
export async function verifyTurnstile(token, ip) {
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: config.turnstileSecret, response: token, ...(ip && { remoteip: ip }) }),
    });
    return (await res.json()).success === true;
  } catch {
    return false;
  }
}
