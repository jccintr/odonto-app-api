import { withTenant } from '../../db/tenant.js';
import { assertActiveDentist, canSeeContact, ownDentistId } from '../../services/dentistScope.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../utils/errors.js';
import { toAppointmentDto } from '../../utils/dto.js';
import { pageResult, paginate } from '../../utils/pagination.js';
import { assertGoodStanding } from '../../services/standing.js';
import { createEvolution } from '../evolutions/evolutions.service.js';

// situações finais não mudam mais; o resto avança conforme o atendimento acontece
const TRANSITIONS = {
  scheduled: ['confirmed', 'in_progress', 'no_show', 'canceled'],
  confirmed: ['in_progress', 'no_show', 'canceled'],
  in_progress: ['attended'], // iniciado, só se conclui (com o prontuário)
  attended: [],
  no_show: [],
  canceled: [],
};
const RESCHEDULABLE = ['scheduled', 'confirmed'];

const unavailable = () => conflict('Horário indisponível: o dentista já tem um atendimento neste período.', { code: 'SLOT_TAKEN' });
const patientBusy = () => conflict('O paciente já tem um atendimento neste período (com este ou com outro dentista).', { code: 'PATIENT_BUSY' });

// conflito de horário: o banco recusa por dentista ou por paciente; a restrição violada diz qual
const overlapError = (err) => (err.code === '23P01' ? (err.constraint === 'appointments_patient_no_overlap' ? patientBusy() : unavailable()) : err);

const appointmentsQuery = (trx) =>
  trx('appointments')
    .join('patients', 'patients.id', 'appointments.patient_id')
    .join('dentists', 'dentists.id', 'appointments.dentist_id')
    .join('users', 'users.id', 'dentists.user_id')
    .select('appointments.*', 'patients.name as patient_name', 'patients.phone as patient_phone', 'users.name as dentist_name', 'dentists.color as dentist_color');

async function loadAppointment(trx, auth, id) {
  const scope = await ownDentistId(trx, auth);
  const row = await appointmentsQuery(trx)
    .where('appointments.id', id)
    .modify((query) => { if (scope) query.where('appointments.dentist_id', scope); })
    .first();
  if (!row) throw notFound('Atendimento');
  return row;
}

const filteredList = (trx, filters, scope) =>
  appointmentsQuery(trx).modify((query) => {
    const dentistId = scope ?? filters.dentistId;
    if (dentistId) query.where('appointments.dentist_id', dentistId);
    if (filters.patientId) query.where('appointments.patient_id', filters.patientId);
    if (filters.status) query.where('appointments.status', filters.status);
    if (filters.from) query.where('appointments.ends_at', '>', filters.from);
    if (filters.to) query.where('appointments.starts_at', '<', filters.to);
  });

/** Lista atendimentos que encostam no intervalo [from, to). Dentista: só os dele. */
export function listAppointments(auth, filters) {
  return withTenant(auth.clinicId, async (trx) => {
    const scope = await ownDentistId(trx, auth);
    const [{ count }] = await filteredList(trx, filters, scope).clearSelect().clearOrder().count({ count: '*' });
    const { limit, offset } = paginate(filters);
    const rows = await filteredList(trx, filters, scope).orderBy('appointments.starts_at').limit(limit).offset(offset);
    return pageResult(rows.map((row) => toAppointmentDto(row, { contact: canSeeContact(auth) })), Number(count), filters);
  });
}

export function getAppointment(auth, id) {
  return withTenant(auth.clinicId, async (trx) => toAppointmentDto(await loadAppointment(trx, auth, id), { contact: canSeeContact(auth) }));
}

// Não se agenda no passado (a secretária pode registrar um encaixe que começou há poucos minutos).
const PAST_GRACE_MS = 5 * 60_000;
const assertNotPast = (startsAt) => {
  if (new Date(startsAt).getTime() < Date.now() - PAST_GRACE_MS) {
    throw badRequest('Não é possível agendar em data e hora que já passaram.', { code: 'PAST_DATE' });
  }
};

export async function createAppointment(auth, { patientId, dentistId, startsAt, endsAt, notes }) {
  assertNotPast(startsAt);
  try {
    return await withTenant(auth.clinicId, async (trx) => {
      const own = await ownDentistId(trx, auth);
      if (own && dentistId && dentistId !== own) throw forbidden('O dentista só agenda na própria agenda.');
      const chosen = own ?? dentistId;
      if (!chosen) throw badRequest('Informe o dentista.');

      const patient = await trx('patients').where({ id: patientId }).first('active');
      if (!patient) throw notFound('Paciente');
      if (!patient.active) throw unprocessable('Este paciente está arquivado.');
      await assertActiveDentist(trx, chosen);
      await assertGoodStanding(trx, auth, patientId);

      const [{ id }] = await trx('appointments')
        .insert({ clinic_id: auth.clinicId, patient_id: patientId, dentist_id: chosen, starts_at: startsAt, ends_at: endsAt, notes, created_by: auth.userId })
        .returning('id');
      return toAppointmentDto(await appointmentsQuery(trx).where('appointments.id', id).first(), { contact: canSeeContact(auth) });
    });
  } catch (err) {
    throw overlapError(err);
  }
}

/** Remarca/edita. Mudar dentista ou horário volta o atendimento para "agendado" (precisa de nova confirmação). */
export async function updateAppointment(auth, id, changes) {
  try {
    return await withTenant(auth.clinicId, async (trx) => {
      const current = await loadAppointment(trx, auth, id);
      if (!RESCHEDULABLE.includes(current.status)) throw conflict('Só é possível alterar atendimentos agendados ou confirmados.');

      const own = await ownDentistId(trx, auth);
      if (own && changes.dentistId && changes.dentistId !== own) throw forbidden('O dentista só agenda na própria agenda.');
      if (changes.dentistId) await assertActiveDentist(trx, changes.dentistId);

      // remarcar para o passado não vale; manter o horário de um atendimento antigo (ex.: editar observações) continua permitido
      if (changes.startsAt && new Date(changes.startsAt).getTime() !== current.starts_at.getTime()) assertNotPast(changes.startsAt);

      const duration = current.ends_at.getTime() - current.starts_at.getTime();
      const startsAt = changes.startsAt ? new Date(changes.startsAt) : current.starts_at;
      // só o início mudou: mantém a duração
      const endsAt = changes.endsAt ? new Date(changes.endsAt) : new Date(startsAt.getTime() + duration);
      if (endsAt <= startsAt) throw badRequest('O término deve ser depois do início.');

      const moved = Boolean(changes.dentistId || changes.startsAt || changes.endsAt);
      await trx('appointments').where({ id }).update({
        starts_at: startsAt,
        ends_at: endsAt,
        updated_at: new Date(),
        ...(changes.dentistId && { dentist_id: changes.dentistId }),
        ...(changes.notes !== undefined && { notes: changes.notes }),
        ...(moved && { status: 'scheduled' }),
      });
      return toAppointmentDto(await appointmentsQuery(trx).where('appointments.id', id).first(), { contact: canSeeContact(auth) });
    });
  } catch (err) {
    throw overlapError(err);
  }
}

export function changeStatus(auth, id, { status, reason, evolution }) {
  // quem atende registra o que fez: só o dentista (do próprio atendimento) inicia e conclui
  if (status === 'in_progress' && auth.role !== 'dentist') throw forbidden('Só o dentista inicia o atendimento.');
  if (status === 'attended' && auth.role !== 'dentist') throw forbidden('Só o dentista marca o atendimento como atendido, registrando o que foi feito.');
  return withTenant(auth.clinicId, async (trx) => {
    const current = await loadAppointment(trx, auth, id);
    if (!TRANSITIONS[current.status].includes(status)) {
      throw conflict(`Não é possível mudar de "${current.status}" para "${status}".`, { code: 'INVALID_TRANSITION' });
    }
    if (status === 'in_progress') await assertGoodStanding(trx, auth, current.patient_id); // paciente inadimplente não é atendido
    if (status === 'attended') await createEvolution(trx, auth, current, evolution);
    await trx('appointments').where({ id }).update({
      status,
      ...(status === 'in_progress' && { started_at: new Date() }),
      canceled_reason: status === 'canceled' ? (reason ?? null) : null,
      updated_at: new Date(),
    });
    return toAppointmentDto(await appointmentsQuery(trx).where('appointments.id', id).first(), { contact: canSeeContact(auth) });
  });
}
