// Formatação para textos enviados ao paciente (pt-BR, fuso da clínica).
import { config } from '../config/env.js';

/** 123456 → "R$ 1.234,56" */
export const formatMoney = (cents) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100).replace(/ /g, ' ');

/** "sexta-feira, 06/11/2026, às 14:30" no fuso da clínica. */
export function formatDateTime(date) {
  const options = { timeZone: config.timezone };
  const day = new Intl.DateTimeFormat('pt-BR', { ...options, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  const time = new Intl.DateTimeFormat('pt-BR', { ...options, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  return `${day} às ${time}`;
}

/** Só dígitos com DDI 55 para o link do WhatsApp (wa.me). */
export const whatsappNumber = (phone) => `55${phone}`;
