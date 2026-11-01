// Campos de formulário reutilizados nos schemas (zod).
import { z } from '../config/zod.js';
import { isValidCpf, onlyDigits } from './cpf.js';

export const idParams = z.object({ id: z.uuid('Identificador inválido.') });
export const uuidField = z.uuid('Identificador inválido.');

export const cpfField = z
  .string()
  .transform(onlyDigits)
  .refine(isValidCpf, 'CPF inválido.');

// DDD + número, com ou sem máscara (10 ou 11 dígitos)
export const phoneField = z
  .string()
  .transform(onlyDigits)
  .refine((digits) => /^\d{10,11}$/.test(digits), 'Telefone inválido (informe DDD + número).');

export const optionalText = (max, label = 'Texto') => z.string().trim().max(max, `${label} muito longo.`);
export const isoDate = z.iso.date('Data inválida (use AAAA-MM-DD).');
export const isoDateTime = z.iso.datetime({ offset: true, error: 'Data e hora inválidas (use o formato ISO 8601, ex.: 2026-11-03T14:00:00-03:00).' });
