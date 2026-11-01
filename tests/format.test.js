import { describe, expect, it } from 'vitest';
import { formatDateTime, formatMoney, whatsappNumber } from '../src/utils/format.js';

describe('formatMoney', () => {
  it('formata centavos em reais, com milhar e sem espaço especial', () => {
    expect(formatMoney(123456)).toBe('R$ 1.234,56');
    expect(formatMoney(0)).toBe('R$ 0,00');
    expect(formatMoney(5)).toBe('R$ 0,05');
    expect(formatMoney(100_000_000)).toBe('R$ 1.000.000,00');
  });
});

describe('formatDateTime', () => {
  it('usa o fuso de Brasília, não o do servidor', () => {
    expect(formatDateTime(new Date('2026-11-06T17:30:00Z'))).toBe('sexta-feira, 06/11/2026 às 14:30');
    expect(formatDateTime(new Date('2026-11-07T02:15:00Z'))).toBe('sexta-feira, 06/11/2026 às 23:15'); // ainda é dia 6 em Brasília
  });
});

describe('whatsappNumber', () => {
  it('acrescenta o DDI do Brasil', () => {
    expect(whatsappNumber('35999990000')).toBe('5535999990000');
  });
});
