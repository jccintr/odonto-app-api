import { describe, expect, it } from 'vitest';
import { isValidCpf, onlyDigits } from '../src/utils/cpf.js';

describe('cpf', () => {
  it('onlyDigits remove a máscara', () => {
    expect(onlyDigits('529.982.247-25')).toBe('52998224725');
    expect(onlyDigits(' (35) 9 9999-0000 ')).toBe('35999990000');
  });

  it.each(['52998224725', '529.982.247-25', '11144477735', '12345678909'])('aceita CPF válido %s', (cpf) => {
    expect(isValidCpf(cpf)).toBe(true);
  });

  it.each([
    ['dígitos a menos', '5299822472'],
    ['dígitos a mais', '529982247250'],
    ['todos iguais', '11111111111'],
    ['1º dígito verificador errado', '52998224735'],
    ['2º dígito verificador errado', '52998224726'],
    ['vazio', ''],
  ])('recusa CPF com %s', (_nome, cpf) => {
    expect(isValidCpf(cpf)).toBe(false);
  });
});
