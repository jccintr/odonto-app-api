// Datas "de calendário" (vencimento, dia da marcação) no fuso da clínica, sem depender do fuso do servidor.
import { config } from '../config/env.js';

/** 'AAAA-MM-DD' de um instante, no fuso configurado (padrão: America/Sao_Paulo). */
export const businessDate = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

const pad = (n) => String(n).padStart(2, '0');

/** Soma meses a uma data 'AAAA-MM-DD'; se o dia não existir no mês de destino, usa o último dia (31/01 + 1 mês = 28/02). */
export function addMonths(dateString, months) {
  const [year, month, day] = dateString.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(Math.min(day, lastDay))}`;
}

/** Soma dias a uma data 'AAAA-MM-DD' (pode ser negativo). */
export function addDays(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Dias entre duas datas 'AAAA-MM-DD' (to - from). */
export function daysBetween(from, to) {
  const ms = (s) => Date.UTC(...s.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** Divide um valor em centavos em n parcelas; os centavos que sobram vão uma a uma para as primeiras. */
export function splitAmount(totalCents, parts) {
  const base = Math.floor(totalCents / parts);
  const rest = totalCents - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rest ? 1 : 0));
}
