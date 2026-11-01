// Envio de e-mail por SMTP (conta da Hostinger, a mesma usada nos outros projetos).
// Variáveis: SMTP_HOST, SMTP_USER, SMTP_PASSWORD (obrigatórias), SMTP_PORT (465), SMTP_FROM_NAME ("OdontoApp"),
// SMTP_FROM (padrão: o próprio SMTP_USER; a Hostinger só aceita remetente igual ao da conta).
import fs from 'node:fs';
import nodemailer from 'nodemailer';
import { config, isProduction } from '../config/env.js';

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
  for (const [key, value] of Object.entries(variables)) html = html.replaceAll(`{{${key}}}`, escapeHtml(value));
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

export function sendPasswordResetEmail({ to, name, url, minutes }) {
  return sendEmail({
    to,
    subject: 'Redefinição de senha — OdontoApp',
    html: renderTemplate('password-reset', { NAME: name, URL: url, MINUTES: minutes }),
    text: `Olá, ${name}! Para criar uma nova senha no OdontoApp acesse: ${url}\nO link vale por ${minutes} minutos e só pode ser usado uma vez. Se você não pediu, ignore este e-mail.`,
  });
}
