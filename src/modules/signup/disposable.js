// Domínios de e-mail descartável mais comuns: cadastro de clínica com eles é recusado (freio contra cadastros de mentira).
// Acrescente outros com SIGNUP_BLOCKED_DOMAINS (lista separada por vírgula).
import { config } from '../../config/env.js';

const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'sharklasers.com', '10minutemail.com', '10minutemail.net',
  'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmail.net', 'tempail.com', 'throwawaymail.com', 'yopmail.com', 'yopmail.fr',
  'trashmail.com', 'trashmail.net', 'getnada.com', 'nada.email', 'maildrop.cc', 'dispostable.com', 'fakeinbox.com', 'mailnesia.com',
  'mohmal.com', 'emailondeck.com', 'burnermail.io', 'spamgourmet.com', 'mintemail.com', 'mytemp.email', 'tmpmail.org', 'tmpmail.net',
  'moakt.com', 'inboxkitten.com', 'mail.tm', 'discard.email', 'mailcatch.com', 'e4ward.com', 'jetable.org', 'harakirimail.com',
]);

export function isBlockedEmail(email) {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return DISPOSABLE.has(domain) || config.signupBlockedDomains.includes(domain);
}
