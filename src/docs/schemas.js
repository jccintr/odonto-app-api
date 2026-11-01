// Schemas de RESPOSTA da documentação (OpenAPI 3.1 / JSON Schema). Os de ENTRADA vêm direto dos schemas zod das rotas.
// Todos fechados (additionalProperties: false, todos os campos obrigatórios): os testes validam respostas reais contra eles,
// então qualquer campo novo ou removido nas respostas da API faz um teste falhar até a documentação ser atualizada.
import { CONDITIONS } from '../utils/tooth.js';
import { PAYMENT_METHODS, PAYMENT_STATUSES } from '../utils/payments.js';

const str = { type: 'string' };
const nstr = { type: ['string', 'null'] };
const uuid = { type: 'string', format: 'uuid' };
const nuuid = { type: ['string', 'null'], format: 'uuid' };
const dateTime = { type: 'string', format: 'date-time' };
const nDateTime = { type: ['string', 'null'], format: 'date-time' };
const date = { type: 'string', format: 'date' };
const nDate = { type: ['string', 'null'], format: 'date' };
const int = { type: 'integer' };
const nint = { type: ['integer', 'null'] };
const bool = { type: 'boolean' };
const enumOf = (values, description) => ({ type: 'string', enum: values, ...(description && { description }) });
const nEnumOf = (values) => ({ type: ['string', 'null'], enum: [...values, null] });
const obj = (properties, description) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false, ...(description && { description }),
});

export const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
export const array = (name) => ({ type: 'array', items: ref(name) });
export const page = (name) => ({
  type: 'object',
  properties: { data: array(name), page: int, perPage: int, total: int, totalPages: int },
  required: ['data', 'page', 'perPage', 'total', 'totalPages'],
  additionalProperties: false,
});

const money = { type: 'integer', description: 'Valor em centavos (15000 = R$ 150,00).' };
const role = enumOf(['admin', 'secretary', 'dentist'], 'admin = administrador da clínica; secretary = secretária; dentist = dentista.');
const budgetStatus = enumOf(['open', 'approved', 'rejected', 'completed'], 'open = em aberto; approved = aprovado; rejected = recusado; completed = todos os itens finalizados (automático).');
const itemStatus = enumOf(['pending', 'done', 'canceled']);
const nMethod = nEnumOf(PAYMENT_METHODS);

export const SCHEMAS = {
  Erro: {
    type: 'object',
    description: 'Formato de todos os erros. `code` identifica regras de negócio (ex.: SLOT_TAKEN); `details` vem nos erros de validação.',
    properties: {
      error: str,
      code: str,
      details: { type: 'array', items: obj({ field: str, message: str }) },
      retryAfterSeconds: int,
      balanceCents: int,
    },
    required: ['error'],
  },
  Mensagem: obj({ message: str }),

  Usuario: obj({
    id: uuid, clinicId: uuid, name: str, email: str, role, active: bool,
    emailVerified: bool, createdAt: dateTime, updatedAt: dateTime,
  }),
  Clinica: obj({
    id: uuid, name: str, slug: str, document: nstr, plan: str, status: enumOf(['active', 'suspended']), createdAt: dateTime, updatedAt: dateTime,
  }),
  Sessao: obj({
    accessToken: { type: 'string', description: 'JWT de acesso (curta duração). Enviar em `Authorization: Bearer ...`.' },
    refreshToken: { type: 'string', description: 'Token opaco de renovação (longa duração, uso único: cada renovação devolve um novo).' },
    user: ref('Usuario'),
    clinic: ref('Clinica'),
  }),
  Perfil: obj({ user: ref('Usuario'), clinic: ref('Clinica') }),
  AdminPlataforma: obj({ id: uuid, name: str, email: str, active: bool }),
  SessaoPlataforma: obj({ token: str, admin: ref('AdminPlataforma') }),
  ClinicaCriada: obj({ clinic: ref('Clinica'), admin: ref('Usuario') }),

  Dentista: obj({
    id: uuid, userId: uuid, name: str, email: str, active: bool, cro: nstr, specialty: nstr,
    color: { type: 'string', description: 'Cor da agenda, #RRGGBB.' },
    payoutPercent: { type: ['number', 'null'], description: 'Percentual de repasse padrão (0 a 100).' },
  }),
  Procedimento: obj({
    id: uuid, name: str, category: nstr, priceCents: money,
    odontogramCondition: { ...nEnumOf(CONDITIONS), description: 'Condição marcada no dente quando o procedimento é realizado.' },
    active: bool, createdAt: dateTime, updatedAt: dateTime,
  }),

  PacienteResumo: obj({ id: uuid, name: str, cpf: nstr, phone: nstr, birthDate: nDate, active: bool }, 'Formato das listas: sem anamnese nem endereço.'),
  Paciente: obj({
    id: uuid, name: str, cpf: { ...nstr, description: 'Só dígitos.' }, birthDate: nDate, phone: { ...nstr, description: 'DDD + número, só dígitos.' }, email: nstr,
    address: obj({ zip: nstr, street: nstr, number: nstr, complement: nstr, district: nstr, city: nstr, state: nstr }),
    guardianName: nstr, guardianPhone: nstr,
    anamnesis: { type: 'object', description: 'Objeto livre com a anamnese.' },
    notes: nstr,
    contactConsent: { type: 'boolean', description: 'Aceite para receber avisos por e-mail e WhatsApp.' },
    consentAt: nDateTime, active: bool, createdAt: dateTime, updatedAt: dateTime,
  }),

  Atendimento: obj({
    id: uuid,
    patient: obj({ id: uuid, name: str, phone: nstr }),
    dentist: obj({ id: uuid, name: str, color: str }),
    startsAt: dateTime, endsAt: dateTime,
    status: enumOf(['scheduled', 'confirmed', 'attended', 'no_show', 'canceled'], 'scheduled = agendado; confirmed = confirmado; attended = atendido; no_show = faltou; canceled = cancelado.'),
    notes: nstr, canceledReason: nstr, createdAt: dateTime, updatedAt: dateTime,
  }),

  ItemOrcamento: obj({
    id: uuid, procedure: obj({ id: uuid, name: str }),
    tooth: { type: ['integer', 'null'], description: 'Dente na numeração FDI (11-48 permanentes, 51-85 de leite).' },
    faces: { ...nstr, description: 'Faces V, L, M, D, O, sempre nessa ordem e sem repetição.' },
    priceCents: money, status: itemStatus, performedByDentistId: nuuid, performedAt: nDateTime, position: int,
  }),
  OrcamentoResumo: obj({
    id: uuid, patient: obj({ id: uuid, name: str }), dentist: obj({ id: uuid, name: str }), status: budgetStatus, notes: nstr,
    itemsCount: { type: 'integer', description: 'Itens não cancelados.' },
    subtotalCents: { ...money, description: 'Soma dos itens não cancelados, em centavos.' },
    discountCents: money,
    totalCents: { ...money, description: 'Subtotal menos desconto, nunca negativo.' },
    approvedAt: nDateTime, createdAt: dateTime, updatedAt: dateTime,
  }),
  Orcamento: {
    ...obj({
      id: uuid, patient: obj({ id: uuid, name: str }), dentist: obj({ id: uuid, name: str }), status: budgetStatus, notes: nstr,
      itemsCount: int, subtotalCents: money, discountCents: money, totalCents: money,
      approvedAt: nDateTime, createdAt: dateTime, updatedAt: dateTime, items: array('ItemOrcamento'),
    }),
  },

  Pagamento: obj({
    id: uuid, budgetId: uuid, patient: obj({ id: uuid, name: str }), amountCents: money, dueDate: date,
    status: enumOf(PAYMENT_STATUSES, 'pending = a receber; paid = recebido; canceled = cancelado/estornado.'),
    overdue: { type: 'boolean', description: 'Pendente com vencimento antes de hoje (horário de Brasília).' },
    method: nMethod, paidAt: nDateTime,
    installment: { ...nint, description: 'Número da parcela, quando gerada por plano de parcelas.' },
    installmentsTotal: nint, canceledReason: nstr, notes: nstr, createdAt: dateTime, updatedAt: dateTime,
  }),
  ResumoFinanceiro: obj({
    totalCents: { ...money, description: 'Total do orçamento (subtotal menos desconto).' },
    scheduledCents: { ...money, description: 'Já lançado (pendente + recebido); cancelados não contam.' },
    paidCents: money, pendingCents: money, overdueCents: money,
    balanceCents: { ...money, description: 'Saldo ainda sem lançamento (nunca negativo).' },
  }),
  PagamentosDoOrcamento: obj({ summary: ref('ResumoFinanceiro'), data: array('Pagamento') }),

  MarcacaoDente: obj({
    id: uuid, tooth: int, faces: nstr, condition: enumOf(CONDITIONS), notes: nstr, recordedOn: date,
    recordedBy: uuid, sourceItemId: { ...nuuid, description: 'Item de orçamento que gerou a marcação, quando foi automática.' }, createdAt: dateTime,
  }),
  Odontograma: obj({
    patientId: uuid,
    teeth: { type: 'object', description: 'Marcações atuais agrupadas pelo número do dente (FDI).', additionalProperties: array('MarcacaoDente') },
  }),
};
