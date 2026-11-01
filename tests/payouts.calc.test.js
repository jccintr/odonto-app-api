import { describe, expect, it } from 'vitest';
import { commissionFor, netOfDiscount, percentOf, pickRule, releasedCents, toBasisPoints } from '../src/utils/payouts.js';

describe('percentOf', () => {
  it('calcula em centésimos de ponto percentual, arredondando para o centavo mais próximo', () => {
    expect(percentOf(1000, 12.5)).toBe(125);
    expect(percentOf(100, 33.33)).toBe(33);
    expect(percentOf(20000, 30)).toBe(6000);
    expect(percentOf(0, 50)).toBe(0);
    expect(percentOf(999, 0)).toBe(0);
    expect(percentOf(333, 100)).toBe(333);
  });

  it('aceita o percentual como texto, do jeito que o Postgres devolve (decimal)', () => {
    expect(toBasisPoints('30.00')).toBe(3000);
    expect(percentOf(20000, '30.00')).toBe(6000);
  });
});

describe('netOfDiscount', () => {
  it('reparte o desconto do orçamento proporcionalmente ao preço de cada item', () => {
    expect(netOfDiscount(20000, 40000, 4000)).toBe(18000);
    expect(netOfDiscount(10000, 30000, 3000)).toBe(9000);
  });

  it('sem desconto (ou subtotal zerado) o item fica com o preço cheio', () => {
    expect(netOfDiscount(20000, 40000, 0)).toBe(20000);
    expect(netOfDiscount(0, 0, 0)).toBe(0);
    expect(netOfDiscount(5000, 0, 100)).toBe(5000);
  });

  it('desconto total zera o item', () => {
    expect(netOfDiscount(5000, 5000, 5000)).toBe(0);
  });
});

describe('pickRule', () => {
  const dentistId = 'd1';
  const procedureId = 'p1';
  const rules = [
    { procedure_id: 'p1', dentist_id: null, type: 'fixed', fixed_cents: 5000, percent: null },
    { procedure_id: 'p1', dentist_id: 'd1', type: 'percent', percent: '50.00', fixed_cents: null },
    { procedure_id: 'p1', dentist_id: 'd2', type: 'percent', percent: '10.00', fixed_cents: null },
    { procedure_id: 'p2', dentist_id: null, type: 'percent', percent: '20.00', fixed_cents: null },
  ];
  const base = { dentistId, procedureId, dentistPercent: 30, defaultPercent: 10 };

  it('dentista + procedimento vence todas as outras', () => {
    const { source, rule } = pickRule(rules, base);
    expect(source).toBe('dentist_procedure');
    expect(rule.percent).toBe('50.00');
  });

  it('sem regra do dentista, vale a regra do procedimento (para qualquer dentista)', () => {
    const { source, rule } = pickRule(rules, { ...base, dentistId: 'd9' });
    expect(source).toBe('procedure');
    expect(rule).toMatchObject({ type: 'fixed', fixed_cents: 5000 });
  });

  it('regra de outro dentista nunca vale para este', () => {
    const only = rules.filter((r) => r.dentist_id === 'd2');
    expect(pickRule(only, base).source).toBe('dentist');
  });

  it('sem regra do procedimento, vale o percentual do dentista, e depois o padrão da clínica', () => {
    expect(pickRule(rules, { ...base, procedureId: 'p9' })).toEqual({ source: 'dentist', rule: { type: 'percent', percent: 30, fixed_cents: null } });
    expect(pickRule(rules, { ...base, procedureId: 'p9', dentistPercent: null })).toEqual({ source: 'clinic_default', rule: { type: 'percent', percent: 10, fixed_cents: null } });
    expect(pickRule([], { ...base, dentistPercent: undefined }).source).toBe('clinic_default');
  });

  it('percentual 0% do dentista é uma regra válida (não cai no padrão da clínica)', () => {
    expect(pickRule([], { ...base, dentistPercent: 0 }).source).toBe('dentist');
  });
});

describe('commissionFor', () => {
  it('percentual incide sobre a base; valor fixo não depende dela', () => {
    expect(commissionFor(15000, { type: 'percent', percent: '40.00' })).toBe(6000);
    expect(commissionFor(15000, { type: 'fixed', fixed_cents: 2500 })).toBe(2500);
    expect(commissionFor(0, { type: 'fixed', fixed_cents: 2500 })).toBe(2500);
  });
});

describe('releasedCents', () => {
  const percent = { type: 'percent' };
  const procedureMode = { releaseOn: 'procedure' };
  const paymentMode = { releaseOn: 'payment', deductCardFees: false, creditCardFeePercent: 0, debitCardFeePercent: 0 };

  it('liberação na execução: libera tudo, mesmo sem pagamento do paciente', () => {
    expect(releasedCents(6000, percent, procedureMode, { totalCents: 20000, paidByMethod: {} })).toBe(6000);
  });

  it('liberação pelo pagamento: proporcional ao que o paciente já pagou do orçamento', () => {
    const state = (paid) => ({ totalCents: 20000, paidByMethod: { pix: paid } });
    expect(releasedCents(6000, percent, paymentMode, state(0))).toBe(0);
    expect(releasedCents(6000, percent, paymentMode, state(5000))).toBe(1500);
    expect(releasedCents(6000, percent, paymentMode, state(20000))).toBe(6000);
  });

  it('nunca libera mais que a comissão (pagamento acima do total) nem divide por zero (total zerado)', () => {
    expect(releasedCents(6000, percent, paymentMode, { totalCents: 20000, paidByMethod: { pix: 99999 } })).toBe(6000);
    expect(releasedCents(6000, percent, paymentMode, { totalCents: 0, paidByMethod: { pix: 100 } })).toBe(0);
  });

  it('soma pagamentos de várias formas', () => {
    expect(releasedCents(6000, percent, paymentMode, { totalCents: 20000, paidByMethod: { pix: 5000, cash: 5000 } })).toBe(3000);
  });

  describe('taxa do cartão', () => {
    const fees = { releaseOn: 'payment', deductCardFees: true, creditCardFeePercent: 5, debitCardFeePercent: 2 };
    const paid = { totalCents: 10000, paidByMethod: { credit_card: 4000, debit_card: 1000, pix: 5000 } };

    it('reduz só a parte paga no cartão (crédito e débito têm taxas próprias; pix e dinheiro não têm)', () => {
      // recebido líquido: 4000-200 + 1000-20 + 5000 = 9780 de 10000
      expect(releasedCents(1000, percent, fees, paid)).toBe(978);
    });

    it('não vale para comissão em valor fixo', () => {
      expect(releasedCents(1000, { type: 'fixed' }, fees, paid)).toBe(1000);
    });

    it('com a opção desligada, a taxa é ignorada', () => {
      expect(releasedCents(1000, percent, { ...fees, deductCardFees: false }, paid)).toBe(1000);
    });

    it('não se aplica quando a liberação é na execução', () => {
      expect(releasedCents(1000, percent, { ...fees, releaseOn: 'procedure' }, paid)).toBe(1000);
    });
  });
});
