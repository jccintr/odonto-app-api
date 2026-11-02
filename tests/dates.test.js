import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, addMonths, businessDate, daysBetween, splitAmount } from '../src/utils/dates.js';

afterEach(() => vi.unstubAllEnvs());

describe('businessDate', () => {
  it('usa o horário de Brasília: 02:00 UTC ainda é o dia anterior', () => {
    expect(businessDate(new Date('2026-11-03T02:00:00Z'))).toBe('2026-11-02');
    expect(businessDate(new Date('2026-11-03T03:00:00Z'))).toBe('2026-11-03');
    expect(businessDate(new Date('2026-11-03T23:30:00-03:00'))).toBe('2026-11-03');
  });

  it('sem argumento, devolve hoje; o fuso é configurável (TIMEZONE)', () => {
    expect(businessDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    vi.stubEnv('TIMEZONE', 'UTC');
    expect(businessDate(new Date('2026-11-03T02:00:00Z'))).toBe('2026-11-03');
  });
});

describe('addMonths', () => {
  it.each([
    ['2026-11-15', 0, '2026-11-15'],
    ['2026-11-15', 3, '2027-02-15'],
    ['2026-01-31', 1, '2026-02-28'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2026-12-31', 2, '2027-02-28'],
    ['2026-03-31', 1, '2026-04-30'],
    ['2026-05-10', 12, '2027-05-10'],
  ])('%s + %i mês(es) = %s', (date, months, expected) => {
    expect(addMonths(date, months)).toBe(expected);
  });
});

describe('splitAmount', () => {
  it('divide em centavos, e a sobra vai uma a uma para as primeiras parcelas', () => {
    expect(splitAmount(100, 3)).toEqual([34, 33, 33]);
    expect(splitAmount(90, 3)).toEqual([30, 30, 30]);
    expect(splitAmount(10, 4)).toEqual([3, 3, 2, 2]);
    expect(splitAmount(1, 1)).toEqual([1]);
    for (const [total, parts] of [[100001, 7], [99999, 12], [5, 5]]) {
      const split = splitAmount(total, parts);
      expect(split.reduce((a, b) => a + b, 0)).toBe(total);
      expect(split).toHaveLength(parts);
    }
  });
});

describe('addDays e daysBetween', () => {
  it.each([
    ['2026-11-30', 1, '2026-12-01'], ['2026-12-31', 1, '2027-01-01'], ['2026-03-01', -1, '2026-02-28'], ['2028-03-01', -1, '2028-02-29'],
    ['2026-11-15', 0, '2026-11-15'], ['2026-01-01', 365, '2027-01-01'],
  ])('%s + %i dia(s) = %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });

  it('daysBetween conta dias de calendário, com sinal e sem depender de horário de verão', () => {
    expect(daysBetween('2026-11-01', '2026-11-15')).toBe(14);
    expect(daysBetween('2026-11-15', '2026-11-01')).toBe(-14);
    expect(daysBetween('2026-11-15', '2026-11-15')).toBe(0);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetween('2026-10-01', '2026-11-01')).toBe(31);
  });
});
