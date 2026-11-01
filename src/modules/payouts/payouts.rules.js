import { withTenant } from '../../db/tenant.js';
import { recordAudit } from '../../services/audit.js';
import { conflict, notFound } from '../../utils/errors.js';
import { toPayoutRuleDto } from '../../utils/dto.js';
import { resolveRule } from './payouts.accrual.js';
import { loadSettings } from './payouts.settings.js';

const rulesQuery = (trx) =>
  trx('payout_rules')
    .join('procedures', 'procedures.id', 'payout_rules.procedure_id')
    .leftJoin('dentists', 'dentists.id', 'payout_rules.dentist_id')
    .leftJoin('users', 'users.id', 'dentists.user_id')
    .select('payout_rules.*', 'procedures.name as procedure_name', 'users.name as dentist_name');

const valueColumns = ({ type, percent, fixedCents }) => ({
  type, percent: type === 'percent' ? percent : null, fixed_cents: type === 'fixed' ? fixedCents : null,
});

const audit = (trx, auth, id, action) =>
  recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'payout_rule', entityId: id, action });

export function listRules(clinicId, { procedureId, dentistId }) {
  return withTenant(clinicId, async (trx) => {
    const rows = await rulesQuery(trx)
      .modify((q) => {
        if (procedureId) q.where('payout_rules.procedure_id', procedureId);
        if (dentistId) q.where('payout_rules.dentist_id', dentistId);
      })
      .orderBy(['procedures.name', 'users.name']);
    return rows.map(toPayoutRuleDto);
  });
}

export async function createRule(auth, input) {
  try {
    return await withTenant(auth.clinicId, async (trx) => {
      if (!(await trx('procedures').where({ id: input.procedureId }).first('id'))) throw notFound('Procedimento');
      if (input.dentistId && !(await trx('dentists').where({ id: input.dentistId }).first('id'))) throw notFound('Dentista');
      const [{ id }] = await trx('payout_rules')
        .insert({ clinic_id: auth.clinicId, procedure_id: input.procedureId, dentist_id: input.dentistId ?? null, ...valueColumns(input) })
        .returning('id');
      await audit(trx, auth, id, 'create');
      return toPayoutRuleDto(await rulesQuery(trx).where('payout_rules.id', id).first());
    });
  } catch (err) {
    if (err.code === '23505') throw conflict('Já existe uma regra para este procedimento e dentista.', { code: 'RULE_EXISTS' });
    throw err;
  }
}

export function updateRule(auth, id, input) {
  return withTenant(auth.clinicId, async (trx) => {
    const updated = await trx('payout_rules').where({ id }).update({ ...valueColumns(input), updated_at: new Date() });
    if (!updated) throw notFound('Regra de repasse');
    await audit(trx, auth, id, 'update');
    return toPayoutRuleDto(await rulesQuery(trx).where('payout_rules.id', id).first());
  });
}

/** Remover a regra não altera lançamentos já feitos (eles guardam a regra aplicada). */
export function deleteRule(auth, id) {
  return withTenant(auth.clinicId, async (trx) => {
    if (!(await trx('payout_rules').where({ id }).del())) throw notFound('Regra de repasse');
    await audit(trx, auth, id, 'delete');
  });
}

/** "Qual regra vale para este dentista neste procedimento?" Ajuda a conferir a configuração. */
export function resolveFor(clinicId, { dentistId, procedureId }) {
  return withTenant(clinicId, async (trx) => {
    const dentist = await trx('dentists').join('users', 'users.id', 'dentists.user_id').where('dentists.id', dentistId).first('dentists.id', 'users.name');
    if (!dentist) throw notFound('Dentista');
    const procedure = await trx('procedures').where({ id: procedureId }).first('id', 'name');
    if (!procedure) throw notFound('Procedimento');
    const { source, rule } = await resolveRule(trx, { dentistId, procedureId }, await loadSettings(trx));
    return {
      dentist: { id: dentist.id, name: dentist.name },
      procedure: { id: procedure.id, name: procedure.name },
      source,
      type: rule.type,
      percent: rule.type === 'percent' ? Number(rule.percent) : null,
      fixedCents: rule.type === 'fixed' ? rule.fixed_cents : null,
    };
  });
}
