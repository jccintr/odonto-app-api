// Situação da assinatura de uma clínica, CALCULADA das datas (nada de cron suspendendo ninguém).
//
//   trial      dentro do teste grátis             active    plano pago em dia            courtesy  cortesia (grátis) da plataforma
//   past_due   venceu há poucos dias (carência): segue usando, com aviso
//   suspended  passou da carência: o painel só abre a tela de assinatura e a exportação dos dados
//   canceled   suspensa há muito tempo: igual a suspensa, mas sinaliza que a conta está para ser encerrada
import { config } from '../../config/env.js';
import { addDays, daysBetween } from '../../utils/dates.js';

export const BILLING_STATES = ['trial', 'active', 'courtesy', 'past_due', 'suspended', 'canceled'];

const latest = (...dates) => dates.filter(Boolean).sort().at(-1);

/** Último dia coberto (teste, pagamento ou cortesia). */
export const coveredUntil = (sub) => latest(sub.trial_ends_on, sub.paid_until, sub.courtesy_until);

/**
 * @param sub  linha de subscriptions (trial_ends_on, paid_until, courtesy_until, courtesy_indefinite)
 * @param today 'AAAA-MM-DD' no fuso de Brasília
 * @returns { state, blocked, endsOn, daysLeft, graceEndsOn }  daysLeft negativo = dias de atraso
 */
export function computeAccess(sub, today) {
  if (sub.courtesy_indefinite) return { state: 'courtesy', blocked: false, endsOn: null, daysLeft: null, graceEndsOn: null };

  const covered = (state, endsOn) => ({
    state, blocked: false, endsOn, daysLeft: daysBetween(today, endsOn), graceEndsOn: addDays(endsOn, config.graceDays),
  });
  if (sub.paid_until && sub.paid_until >= today) return covered('active', sub.paid_until);
  if (sub.courtesy_until && sub.courtesy_until >= today) return covered('courtesy', sub.courtesy_until);
  if (sub.trial_ends_on >= today) return covered('trial', sub.trial_ends_on);

  const endsOn = coveredUntil(sub);
  const overdue = daysBetween(endsOn, today);
  let state = 'past_due';
  if (overdue > config.graceDays) state = overdue > config.graceDays + config.cancelAfterDays ? 'canceled' : 'suspended';
  return {
    state, blocked: state !== 'past_due', endsOn, daysLeft: -overdue, graceEndsOn: addDays(endsOn, config.graceDays),
  };
}

/** Quando a assinatura está suspensa, só estas rotas funcionam: entrar/sair, a tela de assinatura, a exportação dos dados e a leitura da clínica. */
const OPEN = [/^\/api\/auth(\/|$)/, /^\/api\/billing(\/|$)/, /^\/api\/account(\/|$)/];
export const isOpenWhenSuspended = (method, path) => OPEN.some((re) => re.test(path)) || (method === 'GET' && path === '/api/clinic');

/** Início do próximo período a pagar: logo depois da cobertura atual; se já venceu, começa hoje. */
export function nextPeriodStart(sub, today) {
  const covered = coveredUntil(sub);
  return covered >= today ? addDays(covered, 1) : today;
}
