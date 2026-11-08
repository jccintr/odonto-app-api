// Adimplência do paciente: parcela pendente vencida há mais dias que a tolerância da clínica bloqueia novos
// atendimentos e o início dos que já estão marcados. Pagar (ou renegociar o vencimento) desbloqueia sozinho;
// o administrador pode abrir uma exceção com motivo.
import { addDays, businessDate } from '../utils/dates.js';
import { conflict } from '../utils/errors.js';

/** Situação financeira do paciente. Precisa rodar dentro de withTenant (o RLS limita tudo à clínica). */
export async function patientStanding(trx, patientId) {
  const { overdue_grace_days: graceDays } = await trx('clinics').first('overdue_grace_days');
  const limit = addDays(businessDate(), -graceDays); // vencida antes desta data = atrasada além da tolerância
  const [late] = await trx('payments')
    .where({ patient_id: patientId, status: 'pending' })
    .where('due_date', '<', limit)
    .select(trx.raw('coalesce(sum(amount_cents), 0)::int AS cents'), trx.raw('count(*)::int AS count'), trx.raw('min(due_date) AS oldest'));
  const release = await trx('block_releases').where({ patient_id: patientId }).where('valid_until', '>', new Date()).orderBy('valid_until', 'desc').first('valid_until', 'reason');
  const overdue = late.count > 0;
  return {
    blocked: overdue && !release,
    overdue,
    overdueCents: late.cents,
    overdueCount: late.count,
    oldestDueDate: late.oldest,
    graceDays,
    releasedUntil: release?.valid_until ?? null,
    releaseReason: release?.reason ?? null,
  };
}

/** Recusa (409 PATIENT_BLOCKED) quando o paciente está bloqueado. O dentista não recebe detalhes financeiros. */
export async function assertGoodStanding(trx, auth, patientId) {
  const standing = await patientStanding(trx, patientId);
  if (!standing.blocked) return;
  const message = auth.role === 'dentist'
    ? 'Paciente com pendência financeira. Encaminhe-o à recepção.'
    : `Paciente com pagamento em atraso além da tolerância (${standing.graceDays} dia(s)). Regularize o pagamento ou peça a liberação ao administrador.`;
  throw conflict(message, { code: 'PATIENT_BLOCKED' });
}
