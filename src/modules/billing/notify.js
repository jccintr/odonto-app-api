import { sendOwnerNotice } from '../../services/mailer.js';

/** Avisa o dono da plataforma por e-mail (OWNER_EMAIL). Falha de envio nunca derruba a operação: só vai para o log. */
export async function notifyOwner(subject, lines) {
  try {
    await sendOwnerNotice({ subject, text: lines.join('\n') });
  } catch (err) {
    console.error('Falha ao avisar o dono da plataforma:', err);
  }
}
