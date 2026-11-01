// Meses 'AAAA-MM' (calendário da clínica) e o SQL que converte um instante na data local da clínica.
import { config } from '../config/env.js';

const pad = (n) => String(n).padStart(2, '0');

/** Primeiro e último dia de um mês 'AAAA-MM'. */
export function monthRange(month) {
  const [year, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${pad(last)}` };
}

/** Soma (ou subtrai) meses de 'AAAA-MM'. */
export function shiftMonth(month, delta) {
  const [year, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

/** Expressão SQL: a data (no fuso da clínica) de uma coluna timestamptz. */
export const localDate = (column) => `(${column} AT TIME ZONE '${config.timezone.replace(/'/g, "''")}')::date`;
