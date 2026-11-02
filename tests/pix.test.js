import { describe, it, expect } from 'vitest';
import { buildPixPayload, crc16, normalizePixKey, parsePixPayload, sanitizeText, sanitizeTxid } from '../src/utils/pix.js';

describe('crc16', () => {
  it('bate com o valor de referência CRC16/CCITT-FALSE', () => {
    expect(crc16('123456789')).toBe('29B1');
  });
});

describe('normalizePixKey', () => {
  const ok = (raw, key, type, hint) => expect(normalizePixKey(raw, hint)).toEqual({ ok: true, key, type });

  it('CPF com máscara vira só dígitos', () => ok('529.982.247-25', '52998224725', 'CPF'));
  it('CNPJ com máscara vira só dígitos', () => ok('11.222.333/0001-81', '11222333000181', 'CNPJ'));
  it('CNPJ alfanumérico (2026) fica em maiúsculas', () => ok('12.abc.345/01de-35', '12ABC34501DE35', 'CNPJ'));
  it('telefone com máscara ganha +55', () => ok('(35) 99999-1234', '+5535999991234', 'PHONE'));
  it('telefone com +55 e espaços', () => ok('+55 35 99999-1234', '+5535999991234', 'PHONE'));
  it('e-mail vai para minúsculas', () => ok('  Loja@Email.COM ', 'loja@email.com', 'EMAIL'));
  it('chave aleatória vai para minúsculas, com os hífens', () => {
    ok('3F2A9C1E-8B7D-4E6A-9C1D-2B3A4F5E6D7C', '3f2a9c1e-8b7d-4e6a-9c1d-2b3a4f5e6d7c', 'RANDOM');
    ok('3F2A9C1E8B7D4E6A9C1D2B3A4F5E6D7C', '3f2a9c1e-8b7d-4e6a-9c1d-2b3a4f5e6d7c', 'RANDOM');
  });

  it('11 dígitos que só servem como telefone são telefone', () => ok('35999991234', '+5535999991234', 'PHONE'));
  it('11 dígitos que só servem como CPF são CPF', () => ok('11144477735', '11144477735', 'CPF'));

  describe('CPF x telefone', () => {
    const both = '35999990076'; // CPF válido e também tem cara de celular

    it('sem pista é ambígua e devolve as duas opções', () => {
      const r = normalizePixKey(both);
      expect(r).toMatchObject({ ok: false, code: 'PIX_KEY_AMBIGUOUS' });
      expect(r.candidates.map((c) => c.type).sort()).toEqual(['CPF', 'PHONE']);
    });
    it('a máscara resolve', () => {
      ok('359.999.900-76', both, 'CPF');
      ok('(35) 99999-0076', '+5535999990076', 'PHONE');
    });
    it('a dica de tipo resolve', () => {
      ok(both, both, 'CPF', 'CPF');
      ok(both, '+5535999990076', 'PHONE', 'PHONE');
    });
  });

  it('recusa o que não dá para entender', () => {
    for (const bad of ['12345', 'abc', '111.111.111-11', '529.982.247-26', 'sem arroba.com', '(35) 3333-1234', '+1 202 555 0100']) {
      expect(normalizePixKey(bad), bad).toMatchObject({ ok: false, code: 'PIX_KEY_INVALID' });
    }
  });
  it('vazio e dica incompatível', () => {
    expect(normalizePixKey('  ')).toMatchObject({ ok: false, code: 'PIX_KEY_EMPTY' });
    expect(normalizePixKey('loja@email.com', 'CPF')).toMatchObject({ ok: false, code: 'PIX_KEY_INVALID' });
    expect(normalizePixKey('loja@email.com', 'XYZ')).toMatchObject({ ok: false, code: 'PIX_KEY_INVALID' });
  });
});

describe('buildPixPayload', () => {
  const base = { key: 'loja@email.com', name: 'Pizzaria do Zé & Cia', city: 'São Lourenço', amountCents: 13100, txid: 'DLV12' };

  it('monta um BR Code estático com valor, chave, nome, cidade, txid e CRC corretos', () => {
    const p = buildPixPayload(base);
    const f = parsePixPayload(p);
    expect(f['00']).toBe('01');
    expect(f['01']).toBe('11');
    expect(parsePixPayload(f['26'])).toEqual({ '00': 'br.gov.bcb.pix', '01': 'loja@email.com' });
    expect(f['53']).toBe('986');
    expect(f['54']).toBe('131.00');
    expect(f['58']).toBe('BR');
    expect(f['59']).toBe('PIZZARIA DO ZE CIA');
    expect(f['60']).toBe('SAO LOURENCO');
    expect(parsePixPayload(f['62'])).toEqual({ '05': 'DLV12' });
    expect(p.endsWith(f['63'])).toBe(true);
    expect(crc16(p.slice(0, -4))).toBe(f['63']);
  });

  it('corta nome (25) e cidade (15) e limpa o txid', () => {
    const f = parsePixPayload(buildPixPayload({ ...base, name: 'A'.repeat(40), city: 'B'.repeat(40), txid: 'ab-12 #3' }));
    expect(f['59']).toHaveLength(25);
    expect(f['60']).toHaveLength(15);
    expect(parsePixPayload(f['62'])['05']).toBe('ab123');
  });

  it('recusa valor inválido e chave ausente', () => {
    expect(() => buildPixPayload({ ...base, amountCents: 0 })).toThrow();
    expect(() => buildPixPayload({ ...base, amountCents: 12.5 })).toThrow();
    expect(() => buildPixPayload({ ...base, key: '' })).toThrow();
  });

  it('sanitizeText tira acentos e símbolos', () => {
    expect(sanitizeText('Açaí & Cia. Ltda!', 25)).toBe('ACAI CIA LTDA');
  });
});

describe('casos de borda', () => {
  it('dígitos verificadores que dão resto 10 (CPF) ou menor que 2 (CNPJ) viram 0', () => {
    expect(normalizePixKey('000.000.037-00')).toEqual({ ok: true, key: '00000003700', type: 'CPF' });
    expect(normalizePixKey('00.007.919/0001-07')).toEqual({ ok: true, key: '00007919000107', type: 'CNPJ' });
  });

  it('e-mail malformado, texto sem nada útil e símbolos soltos são recusados', () => {
    expect(normalizePixKey('a@b')).toMatchObject({ ok: false, code: 'PIX_KEY_INVALID' });
    expect(normalizePixKey('...')).toMatchObject({ ok: false, code: 'PIX_KEY_INVALID' });
    expect(normalizePixKey('abc$def')).toMatchObject({ ok: false, code: 'PIX_KEY_INVALID' });
  });

  it('telefone com 55 na frente e sem o +', () => {
    expect(normalizePixKey('5535999991234')).toEqual({ ok: true, key: '+5535999991234', type: 'PHONE' });
  });

  it('valor que não é texto e chave grande demais', () => {
    expect(normalizePixKey(null)).toMatchObject({ ok: false, code: 'PIX_KEY_EMPTY' });
    expect(normalizePixKey('a'.repeat(141))).toMatchObject({ ok: false, code: 'PIX_KEY_INVALID' });
  });

  it('textos do BR Code: valores ausentes, nome e cidade em branco', () => {
    expect(sanitizeText(undefined, 10)).toBe('');
    expect(sanitizeTxid(undefined)).toBe('***');
    expect(sanitizeTxid('')).toBe('***');
    const fields = parsePixPayload(buildPixPayload({ key: 'pix@odontoapp.com.br', name: '', city: '', amountCents: 100, txid: 'abc' }));
    expect(fields['59']).toBe('RECEBEDOR');
    expect(fields['60']).toBe('BRASIL');
  });

  it('chave grande demais para caber no BR Code', () => {
    const base = { name: 'X', city: 'Y', amountCents: 100, txid: 'a' };
    expect(() => buildPixPayload({ ...base, key: 'x'.repeat(100) })).toThrow('excede 99');
    expect(() => buildPixPayload({ ...base, key: 'x'.repeat(80) })).toThrow('longa demais');
  });
});
