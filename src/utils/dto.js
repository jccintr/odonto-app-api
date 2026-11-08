// Formato público dos registros (nunca expõe password_hash).
export const toUserDto = (u) => ({
  id: u.id,
  clinicId: u.clinic_id,
  name: u.name,
  email: u.email,
  role: u.role,
  active: u.active,
  emailVerified: Boolean(u.email_verified_at),
  createdAt: u.created_at,
  updatedAt: u.updated_at,
});

export const toClinicDto = (c) => ({
  id: c.id,
  name: c.name,
  slug: c.slug,
  document: c.document,
  plan: c.plan,
  status: c.status,
  overdueGraceDays: c.overdue_grace_days,
  cashDiscountPercent: c.cash_discount_percent,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});

export const toPlatformAdminDto = (a) => ({ id: a.id, name: a.name, email: a.email, active: a.active });

const num = (value) => (value === null ? null : Number(value));

export const toDentistDto = (d) => ({
  id: d.id,
  userId: d.user_id,
  name: d.name,
  email: d.email,
  active: d.active,
  cro: d.cro,
  specialty: d.specialty,
  color: d.color,
  payoutPercent: num(d.payout_percent),
});

export const toProcedureDto = (p) => ({
  id: p.id,
  name: p.name,
  category: p.category,
  priceCents: p.price_cents,
  costCents: p.cost_cents,
  odontogramCondition: p.odontogram_condition,
  active: p.active,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
});

// Telefone é dado de contato: o perfil dentista não o recebe (quem fala com o paciente é a secretária); vem null.
export const toPatientDto = (p, { contact = true } = {}) => ({
  id: p.id,
  name: p.name,
  cpf: p.cpf,
  birthDate: p.birth_date,
  phone: contact ? p.phone : null,
  email: p.email,
  address: { zip: p.zip, street: p.street, number: p.number, complement: p.complement, district: p.district, city: p.city, state: p.state },
  guardianName: p.guardian_name,
  guardianPhone: contact ? p.guardian_phone : null,
  anamnesis: p.anamnesis,
  notes: p.notes,
  contactConsent: p.contact_consent,
  consentAt: p.consent_at,
  active: p.active,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
});

// listas não expõem anamnese nem endereço: esses dados só saem na consulta da ficha (que é auditada)
export const toPatientSummaryDto = (p, { contact = true } = {}) => ({
  id: p.id, name: p.name, cpf: p.cpf, phone: contact ? p.phone : null, birthDate: p.birth_date, active: p.active,
});

export const toAppointmentDto = (a, { contact = true } = {}) => ({
  id: a.id,
  patient: { id: a.patient_id, name: a.patient_name, phone: contact ? a.patient_phone : null },
  dentist: { id: a.dentist_id, name: a.dentist_name, color: a.dentist_color },
  startsAt: a.starts_at,
  endsAt: a.ends_at,
  status: a.status,
  startedAt: a.started_at,
  notes: a.notes,
  canceledReason: a.canceled_reason,
  createdAt: a.created_at,
  updatedAt: a.updated_at,
});

export const toAddendumDto = (a) => ({ id: a.id, evolutionId: a.parent_id, dentist: { id: a.dentist_id, name: a.dentist_name }, description: a.description, createdAt: a.created_at });

// Evolução clínica (prontuário). `addenda` são as retificações; o registro original nunca é alterado.
export const toEvolutionDto = (e, items = [], addenda = []) => ({
  id: e.id,
  appointmentId: e.appointment_id,
  appointmentStartsAt: e.appointment_starts_at,
  canAmend: Boolean(e.can_amend),
  dentist: { id: e.dentist_id, name: e.dentist_name },
  description: e.description,
  procedures: items.map((i) => ({ procedure: { id: i.procedure_id, name: i.procedure_name }, tooth: i.tooth, wholeMouth: i.whole_mouth, faces: i.faces, budgetItemId: i.budget_item_id })),
  addenda: addenda.map(toAddendumDto),
  createdAt: e.created_at,
});

export const toBudgetItemDto = (i) => ({
  id: i.id,
  procedure: { id: i.procedure_id, name: i.procedure_name },
  tooth: i.tooth,
  faces: i.faces,
  priceCents: i.price_cents,
  status: i.status,
  performedByDentistId: i.performed_by_dentist_id,
  performedAt: i.performed_at,
  position: i.position,
  approvalId: i.approval_id,
});

// subtotal = itens que não foram cancelados; total nunca fica negativo
export const toBudgetSummaryDto = (b) => ({
  id: b.id,
  patient: { id: b.patient_id, name: b.patient_name },
  dentist: { id: b.dentist_id, name: b.dentist_name },
  status: b.status,
  notes: b.notes,
  itemsCount: b.items_count,
  subtotalCents: b.subtotal,
  discountCents: b.discount_cents,
  totalCents: Math.max(b.subtotal - b.discount_cents, 0),
  approvedAt: b.approved_at,
  createdAt: b.created_at,
  updatedAt: b.updated_at,
});

export const toApprovalDto = (a) => ({
  id: a.id,
  itemsCount: a.items_count,
  subtotalCents: a.subtotal,
  discountCents: a.discount_cents,
  totalCents: Math.max(a.subtotal - a.discount_cents, 0),
  notes: a.notes,
  createdAt: a.created_at,
});

export const toBudgetDto = (b, items, approvals = []) => ({ ...toBudgetSummaryDto(b), items: items.map(toBudgetItemDto), approvals: approvals.map(toApprovalDto) });

export const toPaymentDto = (p) => ({
  id: p.id,
  budgetId: p.budget_id,
  approvalId: p.approval_id,
  patient: { id: p.patient_id, name: p.patient_name },
  amountCents: p.amount_cents,
  dueDate: p.due_date,
  status: p.status,
  overdue: p.overdue,
  method: p.method,
  paidAt: p.paid_at,
  installment: p.installment,
  installmentsTotal: p.installments_total,
  canceledReason: p.canceled_reason,
  notes: p.notes,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
});

export const toToothRecordDto = (r) => ({
  id: r.id,
  tooth: r.tooth,
  faces: r.faces,
  condition: r.condition,
  notes: r.notes,
  recordedOn: r.recorded_on,
  recordedBy: r.recorded_by,
  recordedByName: r.recorded_by_name ?? null,
  sourceItemId: r.source_item_id,
  createdAt: r.created_at,
});

export const toPayoutRuleDto = (r) => ({
  id: r.id,
  procedure: { id: r.procedure_id, name: r.procedure_name },
  dentist: r.dentist_id ? { id: r.dentist_id, name: r.dentist_name } : null,
  type: r.type,
  percent: num(r.percent),
  fixedCents: r.fixed_cents,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const toPayoutEntryDto = ({ entry: e, released, paid, balance }) => ({
  id: e.id,
  budgetId: e.budget_id,
  item: { id: e.item_id, procedure: { id: e.procedure_id, name: e.procedure_name }, tooth: e.tooth, faces: e.faces },
  patient: { id: e.patient_id, name: e.patient_name },
  dentist: { id: e.dentist_id, name: e.dentist_name },
  performedAt: e.performed_at,
  grossCents: e.gross_cents,
  costCents: e.cost_cents,
  baseCents: e.base_cents,
  rule: { source: e.rule_source, type: e.rule_type, percent: num(e.rule_percent), fixedCents: e.rule_fixed_cents },
  releaseOn: e.terms.releaseOn,
  commissionCents: e.commission_cents,
  releasedCents: released,
  paidCents: paid,
  balanceCents: balance,
});

export const toPayoutDto = (p) => ({
  id: p.id,
  dentist: { id: p.dentist_id, name: p.dentist_name },
  until: p.until,
  totalCents: p.total_cents,
  method: p.method,
  paidAt: p.paid_at,
  notes: p.notes,
  status: p.status,
  canceledReason: p.canceled_reason,
  canceledAt: p.canceled_at,
  createdAt: p.created_at,
});

export const toImageDto = (i, links) => ({
  id: i.id,
  patientId: i.patient_id,
  kind: i.kind,
  tooth: i.tooth,
  takenOn: i.taken_on,
  notes: i.notes,
  format: i.format,
  bytes: i.bytes,
  width: i.width,
  height: i.height,
  uploadedBy: i.uploaded_by,
  createdAt: i.created_at,
  ...links,
});

export const toNotificationDto = (n) => ({
  id: n.id,
  kind: n.kind,
  channel: n.channel,
  trigger: n.trigger,
  patient: { id: n.patient_id, name: n.patient_name },
  appointmentId: n.appointment_id,
  budgetId: n.budget_id,
  recipient: n.recipient,
  subject: n.subject,
  status: n.status,
  attempts: n.attempts,
  lastError: n.last_error,
  sentAt: n.sent_at,
  createdAt: n.created_at,
});

export const toPlanDto = (p) => ({
  id: p.id,
  code: p.code,
  name: p.name,
  description: p.description,
  priceCents: p.price_cents,
  maxDentists: p.max_dentists,
  active: p.active,
});

/** `pix` só vai quando a fatura está em aberto e a plataforma tem chave Pix configurada. */
export const toInvoiceDto = (i, pix = null) => ({
  id: i.id,
  clinicId: i.clinic_id,
  planId: i.plan_id,
  amountCents: i.amount_cents,
  periodStart: i.period_start,
  periodEnd: i.period_end,
  dueOn: i.due_on,
  status: i.status,
  reportedPaidAt: i.reported_paid_at,
  reportedNote: i.reported_note,
  paidAt: i.paid_at,
  paymentNote: i.payment_note,
  createdAt: i.created_at,
  pix,
});
