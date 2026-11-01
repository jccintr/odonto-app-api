import { describe, expect, it } from 'vitest';
import { CONDITIONS, DECIDUOUS_TEETH, FACES, normalizeFaces, PERMANENT_TEETH, TEETH } from '../src/utils/tooth.js';

describe('utils/tooth', () => {
  it('numeração FDI: 32 permanentes e 20 decíduos', () => {
    expect(PERMANENT_TEETH).toHaveLength(32);
    expect(DECIDUOUS_TEETH).toHaveLength(20);
    expect(TEETH).toHaveLength(52);
    expect(PERMANENT_TEETH.slice(0, 3)).toEqual([11, 12, 13]);
    expect(PERMANENT_TEETH.at(-1)).toBe(48);
    expect(DECIDUOUS_TEETH).toEqual(expect.arrayContaining([51, 55, 61, 85]));
    for (const invalid of [10, 19, 56, 9, 90, 0]) expect(TEETH).not.toContain(invalid);
  });

  it('faces e condições', () => {
    expect(FACES).toEqual(['V', 'L', 'M', 'D', 'O']);
    expect(CONDITIONS).toEqual(expect.arrayContaining(['caries', 'restoration', 'root_canal', 'extracted']));
  });

  it('normalizeFaces mantém a ordem canônica, sem repetição', () => {
    expect(normalizeFaces('DOM')).toBe('MDO');
    expect(normalizeFaces('OOVV')).toBe('VO');
    expect(normalizeFaces('VLMDO')).toBe('VLMDO');
    expect(normalizeFaces('')).toBe('');
  });
});
