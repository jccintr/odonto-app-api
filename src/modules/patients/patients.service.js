import { withTenant } from '../../db/tenant.js';
import { recordAudit } from '../../services/audit.js';
import { conflict, notFound } from '../../utils/errors.js';
import { toPatientDto, toPatientSummaryDto } from '../../utils/dto.js';
import { escapeLike, pageResult, paginate } from '../../utils/pagination.js';

const COLUMN = { birthDate: 'birth_date', guardianName: 'guardian_name', guardianPhone: 'guardian_phone' };

// camelCase da API -> colunas; o endereço vira colunas soltas (só as partes enviadas)
function toColumns({ address, ...fields }) {
  const columns = { ...address };
  for (const [key, value] of Object.entries(fields)) columns[COLUMN[key] ?? key] = value;
  return columns;
}

const duplicateCpf = () => conflict('CPF já cadastrado nesta clínica.');

const filtered = (trx, { active, q }) =>
  trx('patients').modify((query) => {
    if (active !== undefined) query.where({ active });
    if (q) {
      const digits = q.replace(/\D/g, '');
      query.where((b) => {
        b.whereILike('name', `%${escapeLike(q)}%`);
        if (digits) b.orWhere('cpf', 'like', `${digits}%`).orWhere('phone', 'like', `%${digits}%`);
      });
    }
  });

export function listPatients(clinicId, filters) {
  return withTenant(clinicId, async (trx) => {
    const [{ count }] = await filtered(trx, filters).count({ count: '*' });
    const { limit, offset } = paginate(filters);
    const rows = await filtered(trx, filters).orderBy('name').limit(limit).offset(offset);
    return pageResult(rows.map(toPatientSummaryDto), Number(count), filters);
  });
}

/** Consulta a ficha completa. Toda leitura fica registrada na auditoria. */
export function getPatient(auth, id) {
  return withTenant(auth.clinicId, async (trx) => {
    const row = await trx('patients').where({ id }).first();
    if (!row) throw notFound('Paciente');
    await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'patient', entityId: id, action: 'read' });
    return toPatientDto(row);
  });
}

export async function createPatient(auth, { contactConsent, ...input }) {
  const columns = {
    ...toColumns(input),
    clinic_id: auth.clinicId,
    created_by: auth.userId,
    ...(contactConsent && { contact_consent: true, consent_at: new Date() }),
  };
  try {
    return await withTenant(auth.clinicId, async (trx) => {
      const [row] = await trx('patients').insert(columns).returning('*');
      await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'patient', entityId: row.id, action: 'create' });
      return toPatientDto(row);
    });
  } catch (err) {
    if (err.code === '23505') throw duplicateCpf();
    throw err;
  }
}

export async function updatePatient(auth, id, { contactConsent, ...input }) {
  try {
    return await withTenant(auth.clinicId, async (trx) => {
      const columns = { ...toColumns(input), updated_at: new Date() };
      if (contactConsent !== undefined) {
        columns.contact_consent = contactConsent;
        // a data do aceite é mantida enquanto o aceite continuar; revogar zera
        columns.consent_at = contactConsent ? trx.raw('COALESCE(consent_at, ?)', [new Date()]) : null;
      }
      const [row] = await trx('patients').where({ id }).update(columns).returning('*');
      if (!row) throw notFound('Paciente');
      const fields = Object.keys(input).concat(contactConsent === undefined ? [] : ['contactConsent']);
      await recordAudit(trx, { clinicId: auth.clinicId, userId: auth.userId, entity: 'patient', entityId: id, action: 'update', changes: { fields } });
      return toPatientDto(row);
    });
  } catch (err) {
    if (err.code === '23505') throw duplicateCpf();
    throw err;
  }
}
