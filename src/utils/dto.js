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

export const toPatientDto = (p) => ({
  id: p.id,
  name: p.name,
  cpf: p.cpf,
  birthDate: p.birth_date,
  phone: p.phone,
  email: p.email,
  address: { zip: p.zip, street: p.street, number: p.number, complement: p.complement, district: p.district, city: p.city, state: p.state },
  guardianName: p.guardian_name,
  guardianPhone: p.guardian_phone,
  anamnesis: p.anamnesis,
  notes: p.notes,
  contactConsent: p.contact_consent,
  consentAt: p.consent_at,
  active: p.active,
  createdAt: p.created_at,
  updatedAt: p.updated_at,
});

// listas não expõem anamnese nem endereço: esses dados só saem na consulta da ficha (que é auditada)
export const toPatientSummaryDto = (p) => ({
  id: p.id, name: p.name, cpf: p.cpf, phone: p.phone, birthDate: p.birth_date, active: p.active,
});

export const toAppointmentDto = (a) => ({
  id: a.id,
  patient: { id: a.patient_id, name: a.patient_name, phone: a.patient_phone },
  dentist: { id: a.dentist_id, name: a.dentist_name, color: a.dentist_color },
  startsAt: a.starts_at,
  endsAt: a.ends_at,
  status: a.status,
  notes: a.notes,
  canceledReason: a.canceled_reason,
  createdAt: a.created_at,
  updatedAt: a.updated_at,
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

export const toBudgetDto = (b, items) => ({ ...toBudgetSummaryDto(b), items: items.map(toBudgetItemDto) });

export const toPaymentDto = (p) => ({
  id: p.id,
  budgetId: p.budget_id,
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
