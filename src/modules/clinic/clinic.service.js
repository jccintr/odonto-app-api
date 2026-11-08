import { withTenant } from '../../db/tenant.js';
import { toClinicDto } from '../../utils/dto.js';
import { findTemplate } from '../signup/templates.js';

// O RLS garante que a consulta só enxerga a própria clínica.
export function getClinic(clinicId) {
  return withTenant(clinicId, async (trx) => toClinicDto(await trx('clinics').first()));
}

export function updateClinic(clinicId, changes) {
  return withTenant(clinicId, async (trx) => {
    const { overdueGraceDays, cashDiscountPercent, ...rest } = changes;
    const [clinic] = await trx('clinics')
      .update({ ...rest, ...(overdueGraceDays !== undefined && { overdue_grace_days: overdueGraceDays }), ...(cashDiscountPercent !== undefined && { cash_discount_percent: cashDiscountPercent }), updated_at: new Date() })
      .returning('*');
    return toClinicDto(clinic);
  });
}

// Primeiros passos da clínica nova (o painel mostra até tudo estar feito).
async function buildOnboarding(trx) {
  const clinic = await trx('clinics').first('template_code', 'prices_reviewed_at');
  const has = async (table, where = {}) => Boolean(await trx(table).where(where).first('id'));
  const steps = [];
  // modelos com procedimentos de exemplo: os preços são só uma referência e precisam ser conferidos
  if (findTemplate(clinic.template_code)?.procedures.length > 0) {
    steps.push({ key: 'prices', label: 'Conferir os preços de exemplo dos procedimentos', done: Boolean(clinic.prices_reviewed_at) });
  }
  steps.push(
    { key: 'team', label: 'Cadastrar a equipe (dentistas e secretárias)', done: await has('dentists') },
    { key: 'patient', label: 'Cadastrar o primeiro paciente', done: await has('patients') },
    { key: 'appointment', label: 'Marcar a primeira consulta', done: await has('appointments') },
  );
  return { steps, completed: steps.every((step) => step.done) };
}

export const getOnboarding = (clinicId) => withTenant(clinicId, buildOnboarding);

export function markPricesReviewed(clinicId) {
  return withTenant(clinicId, async (trx) => {
    await trx('clinics').update({ prices_reviewed_at: new Date(), updated_at: new Date() });
    return buildOnboarding(trx);
  });
}
