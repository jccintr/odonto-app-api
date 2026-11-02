// Envio de e-mail por SMTP (conta da Hostinger, a mesma usada nos outros projetos).
// Variáveis: SMTP_HOST, SMTP_USER, SMTP_PASSWORD (obrigatórias), SMTP_PORT (465), SMTP_FROM_NAME ("OdontoApp"),
// SMTP_FROM (padrão: o próprio SMTP_USER; a Hostinger só aceita remetente igual ao da conta).
import fs from 'node:fs';
import nodemailer from 'nodemailer';
import { config, isProduction } from '../config/env.js';
import { formatMoney } from '../utils/format.js';

export const smtpConfigured = () => Boolean(config.smtpHost && config.smtpUser && config.smtpPassword);

let transporter;
export const resetTransporter = () => { transporter = undefined; };

const getTransporter = () => {
  if (!transporter) {
    const port = config.smtpPort;
    transporter = nodemailer.createTransport({
      pool: true,
      host: config.smtpHost,
      port,
      secure: port === 465, // 465 = TLS direto; 587 = STARTTLS
      auth: { user: config.smtpUser, pass: config.smtpPassword },
    });
  }
  return transporter;
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderTemplate(name, variables = {}) {
  let html = fs.readFileSync(new URL(`../../templates/emails/${name}.html`, import.meta.url), 'utf8');
  // variáveis RAW_* entram sem escape: só para HTML que o próprio código montou escapando cada valor (ex.: linhas da tabela)
  for (const [key, value] of Object.entries(variables)) html = html.replaceAll(`{{${key}}}`, key.startsWith('RAW_') ? value : escapeHtml(value));
  return html;
}

export async function sendEmail({ to, subject, html, text }) {
  if (!smtpConfigured()) {
    // Em produção a falta de SMTP é erro. Em desenvolvimento, imprime o texto do e-mail no console.
    if (isProduction()) throw new Error('SMTP não configurado (SMTP_HOST, SMTP_USER, SMTP_PASSWORD).');
    console.warn(`[e-mail não enviado: SMTP não configurado] para ${to} — ${subject}\n${text}`);
    return { skipped: true };
  }
  const from = `"${config.smtpFromName}" <${config.smtpFrom}>`;
  return getTransporter().sendMail({ from, to, subject, html, text });
}

export function sendVerificationEmail({ to, name, url, hours }) {
  return sendEmail({
    to,
    subject: 'Confirme seu e-mail — OdontoApp',
    html: renderTemplate('email-verification', { NAME: name, URL: url, HOURS: hours }),
    text: `Olá, ${name}! Confirme seu e-mail para ativar o acesso ao OdontoApp: ${url}\nO link vale por ${hours} horas e só pode ser usado uma vez.`,
  });
}

/** Aviso interno para o dono da plataforma (clínica nova, "já paguei", pedido de exclusão). Sem OWNER_EMAIL, não envia. */
export function sendOwnerNotice({ subject, text }) {
  if (!config.ownerEmail) return { skipped: true };
  return sendEmail({ to: config.ownerEmail, subject: `[OdontoApp] ${subject}`, html: `<pre style="font-family:inherit">${escapeHtml(text)}</pre>`, text });
}

export function sendPasswordResetEmail({ to, name, url, minutes }) {
  return sendEmail({
    to,
    subject: 'Redefinição de senha — OdontoApp',
    html: renderTemplate('password-reset', { NAME: name, URL: url, MINUTES: minutes }),
    text: `Olá, ${name}! Para criar uma nova senha no OdontoApp acesse: ${url}\nO link vale por ${minutes} minutos e só pode ser usado uma vez. Se você não pediu, ignore este e-mail.`,
  });
}

/** Lembrete de consulta. `when` já vem formatado (data e hora no fuso da clínica). */
export function sendAppointmentReminderEmail({ to, patientName, clinicName, dentistName, when, address, phone }) {
  const where = [address && `Endereço: ${address}`, phone && `Telefone: ${phone}`].filter(Boolean);
  return sendEmail({
    to,
    subject: `Lembrete da sua consulta — ${clinicName}`,
    html: renderTemplate('appointment-reminder', {
      NAME: patientName, CLINIC: clinicName, DENTIST: dentistName, WHEN: when,
      RAW_CONTACT: where.map((line) => `<p style="margin:4px 0;color:#52606d">${escapeHtml(line)}</p>`).join(''),
    }),
    text: `Olá, ${patientName}! Lembramos da sua consulta na ${clinicName} com ${dentistName}: ${when}.${where.length ? `\n${where.join('\n')}` : ''}\nSe não puder comparecer, avise a clínica com antecedência.`,
  });
}

/** Orçamento enviado ao paciente. `items`: [{ name, tooth, faces, priceCents }]. */
export function sendBudgetEmail({ to, patientName, clinicName, dentistName, items, subtotalCents, discountCents, totalCents, phone }) {
  const label = (item) => [item.name, item.tooth && `dente ${item.tooth}${item.faces ? ` (${item.faces})` : ''}`].filter(Boolean).join(' — ');
  const rows = items.map((item) =>
    `<tr><td style="padding:6px 0;border-bottom:1px solid #e4e7eb">${escapeHtml(label(item))}</td><td align="right" style="padding:6px 0;border-bottom:1px solid #e4e7eb">${escapeHtml(formatMoney(item.priceCents))}</td></tr>`).join('');
  const discount = discountCents > 0
    ? `<tr><td style="padding:6px 0">Desconto</td><td align="right" style="padding:6px 0">- ${escapeHtml(formatMoney(discountCents))}</td></tr>` : '';
  return sendEmail({
    to,
    subject: `Seu orçamento — ${clinicName}`,
    html: renderTemplate('budget', {
      NAME: patientName, CLINIC: clinicName, DENTIST: dentistName, SUBTOTAL: formatMoney(subtotalCents), TOTAL: formatMoney(totalCents),
      RAW_ROWS: rows, RAW_DISCOUNT: discount, PHONE: phone ? `Dúvidas? Ligue para ${phone}.` : 'Dúvidas? Fale com a clínica.',
    }),
    text: [
      `Olá, ${patientName}! Segue o orçamento do tratamento com ${dentistName} (${clinicName}):`,
      ...items.map((item) => `- ${label(item)}: ${formatMoney(item.priceCents)}`),
      ...(discountCents > 0 ? [`Desconto: -${formatMoney(discountCents)}`] : []),
      `Total: ${formatMoney(totalCents)}`,
      phone ? `Dúvidas? Ligue para ${phone}.` : 'Dúvidas? Fale com a clínica.',
    ].join('\n'),
  });
}
