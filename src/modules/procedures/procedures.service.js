import { withTenant } from '../../db/tenant.js';
import { conflict, notFound } from '../../utils/errors.js';
import { toProcedureDto } from '../../utils/dto.js';
import { escapeLike, pageResult, paginate } from '../../utils/pagination.js';

const COLUMN = { priceCents: 'price_cents', odontogramCondition: 'odontogram_condition' };
const toColumns = (input) => Object.fromEntries(Object.entries(input).map(([key, value]) => [COLUMN[key] ?? key, value]));

const duplicateName = () => conflict('Já existe um procedimento com este nome.');

const filtered = (trx, { active, q }) =>
  trx('procedures').modify((query) => {
    if (active !== undefined) query.where({ active });
    if (q) query.where((b) => b.whereILike('name', `%${escapeLike(q)}%`).orWhereILike('category', `%${escapeLike(q)}%`));
  });

export function listProcedures(clinicId, filters) {
  return withTenant(clinicId, async (trx) => {
    const [{ count }] = await filtered(trx, filters).count({ count: '*' });
    const { limit, offset } = paginate(filters);
    const rows = await filtered(trx, filters).orderBy('name').limit(limit).offset(offset);
    return pageResult(rows.map(toProcedureDto), Number(count), filters);
  });
}

export function getProcedure(clinicId, id) {
  return withTenant(clinicId, async (trx) => {
    const row = await trx('procedures').where({ id }).first();
    if (!row) throw notFound('Procedimento');
    return toProcedureDto(row);
  });
}

export async function createProcedure(clinicId, input) {
  try {
    const [row] = await withTenant(clinicId, (trx) =>
      trx('procedures').insert({ clinic_id: clinicId, ...toColumns(input) }).returning('*'));
    return toProcedureDto(row);
  } catch (err) {
    if (err.code === '23505') throw duplicateName();
    throw err;
  }
}

export async function updateProcedure(clinicId, id, input) {
  const changes = { ...toColumns(input), updated_at: new Date() };
  try {
    const [row] = await withTenant(clinicId, (trx) => trx('procedures').where({ id }).update(changes).returning('*'));
    if (!row) throw notFound('Procedimento');
    return toProcedureDto(row);
  } catch (err) {
    if (err.code === '23505') throw duplicateName();
    throw err;
  }
}
