// Schemas de RESPOSTA da documentação (OpenAPI 3.1 / JSON Schema). Os de ENTRADA vêm direto dos schemas zod das rotas.
// Todos fechados (additionalProperties: false, todos os campos obrigatórios): os testes validam respostas reais contra eles,
// então qualquer campo novo ou removido nas respostas da API faz um teste falhar até a documentação ser atualizada.
import { NOTIFICATION_KINDS, NOTIFICATION_STATUSES, NOTIFICATION_TRIGGERS } from '../utils/notifications.js';
import { IMAGE_FORMATS, IMAGE_KINDS } from '../utils/images.js';
import { PAYOUT_RELEASE_MODES, PAYOUT_RULE_SOURCES, PAYOUT_RULE_TYPES, PAYOUT_STATUSES } from '../utils/payouts.js';
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
const num = { type: 'number' };
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
    costCents: { ...money, description: 'Custo (laboratório/material). Só entra no cálculo do repasse se a clínica optar por descontar custos.' },
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

  ConfigRepasse: obj({
    releaseOn: enumOf(PAYOUT_RELEASE_MODES, 'payment = a comissão é liberada na proporção do que o paciente pagou; procedure = liberada por inteiro quando o procedimento é realizado.'),
    deductCosts: { type: 'boolean', description: 'Desconta o custo do procedimento antes de calcular a comissão.' },
    deductCardFees: { type: 'boolean', description: 'Desconta a taxa do cartão (só em liberação por pagamento e só em comissões em percentual).' },
    creditCardFeePercent: num, debitCardFeePercent: num,
    defaultPercent: { ...num, description: 'Percentual usado quando não há regra do procedimento nem percentual do dentista.' },
  }),
  RegraOrigem: enumOf(PAYOUT_RULE_SOURCES, 'dentist_procedure = regra do dentista naquele procedimento; procedure = regra do procedimento; dentist = percentual do dentista; clinic_default = percentual padrão da clínica.'),
  RegraRepasse: obj({
    id: uuid, procedure: obj({ id: uuid, name: str }), dentist: { ...obj({ id: uuid, name: str }), type: ['object', 'null'] },
    type: enumOf(PAYOUT_RULE_TYPES, 'percent = percentual da base; fixed = valor fixo por procedimento realizado.'),
    percent: { type: ['number', 'null'] }, fixedCents: nint, createdAt: dateTime, updatedAt: dateTime,
  }),
  RegraAplicada: obj({
    dentist: obj({ id: uuid, name: str }), procedure: obj({ id: uuid, name: str }), source: ref('RegraOrigem'),
    type: enumOf(PAYOUT_RULE_TYPES), percent: { type: ['number', 'null'] }, fixedCents: nint,
  }),
  LancamentoRepasse: obj({
    id: uuid, budgetId: uuid,
    item: obj({ id: uuid, procedure: obj({ id: uuid, name: str }), tooth: nint, faces: nstr }),
    patient: obj({ id: uuid, name: str }), dentist: obj({ id: uuid, name: str }), performedAt: dateTime,
    grossCents: { ...money, description: 'Valor do procedimento já com a parte do desconto do orçamento.' },
    costCents: { ...money, description: 'Custo descontado (zero se a clínica não desconta custos).' },
    baseCents: { ...money, description: 'Base de cálculo: valor menos custo.' },
    rule: obj({ source: ref('RegraOrigem'), type: enumOf(PAYOUT_RULE_TYPES), percent: { type: ['number', 'null'] }, fixedCents: nint }),
    releaseOn: enumOf(PAYOUT_RELEASE_MODES),
    commissionCents: { ...money, description: 'Comissão total quando tudo for recebido. Congelada na execução.' },
    releasedCents: { type: 'integer', description: 'Parte já liberada até a data consultada.' },
    paidCents: { type: 'integer', description: 'Já repassado ao dentista (fechamentos pagos).' },
    balanceCents: { type: 'integer', description: 'Liberado menos pago. Negativo quando um pagamento do paciente foi estornado depois do repasse.' },
  }),
  SaldoDentista: obj({
    dentist: obj({ id: uuid, name: str }), entriesCount: int, commissionCents: int, releasedCents: int, paidCents: int, balanceCents: int,
  }),
  SaldosRepasse: obj({
    until: date,
    data: array('SaldoDentista'),
    totals: obj({ commissionCents: int, releasedCents: int, paidCents: int, balanceCents: int }),
  }),
  FechamentoRepasse: obj({
    id: uuid, dentist: obj({ id: uuid, name: str }), until: date, totalCents: money,
    method: enumOf(PAYMENT_METHODS), paidAt: dateTime, notes: nstr, status: enumOf(PAYOUT_STATUSES, 'paid = pago; canceled = desfeito (o saldo volta aos lançamentos).'),
    canceledReason: nstr, canceledAt: nDateTime, createdAt: dateTime,
  }),
  FechamentoRepasseDetalhe: obj({
    id: uuid, dentist: obj({ id: uuid, name: str }), until: date, totalCents: money,
    method: enumOf(PAYMENT_METHODS), paidAt: dateTime, notes: nstr, status: enumOf(PAYOUT_STATUSES),
    canceledReason: nstr, canceledAt: nDateTime, createdAt: dateTime,
    lines: { type: 'array', items: obj({ entryId: uuid, amountCents: { type: 'integer', description: 'Negativo = desconto de pagamento estornado.' }, performedAt: dateTime, procedure: str, patient: str }) },
  }),

  RelatorioMensal: obj({
    month: str, from: date, to: date,
    cash: obj({
      receivedCents: { ...money, description: 'Tudo que entrou no mês (inclui o que foi estornado depois).' },
      refundedCents: { ...money, description: 'Estornos feitos no mês, de pagamentos recebidos em qualquer data.' },
      netCashCents: { type: 'integer', description: 'Recebido menos estornos.' },
      byMethod: { type: 'array', items: obj({ method: nMethod, amountCents: money }) },
      dueInMonth: obj({ pendingCents: { ...money, description: 'A receber com vencimento no mês, ainda no prazo.' }, overdueCents: { ...money, description: 'Com vencimento no mês e já vencido (hoje).' } }),
    }),
    production: obj({
      proceduresCount: int,
      producedCents: { ...money, description: 'Valor de tabela dos procedimentos realizados no mês (antes do desconto do orçamento).' },
      topProcedures: { type: 'array', description: 'Até 5, do maior para o menor valor produzido.', items: obj({ procedure: obj({ id: uuid, name: str }), count: int, producedCents: money }) },
    }),
    appointments: obj({
      total: int, scheduled: int, confirmed: int, attended: int, no_show: int, canceled: int,
      attendanceRate: { type: ['number', 'null'], description: 'Atendidos / (atendidos + faltas); null sem base.' },
      noShowRate: { type: ['number', 'null'], description: 'Faltas / (atendidos + faltas); null sem base.' },
    }),
    budgets: obj({
      createdCount: int, rejectedCount: int, approvedCount: int,
      approvedCents: { ...money, description: 'Total (itens menos desconto) dos orçamentos aprovados no mês.' },
      conversionRate: { type: ['number', 'null'], description: 'Dos orçamentos criados no mês, a parte que já foi aprovada; null sem orçamentos.' },
    }),
    newPatients: int,
    payouts: obj({
      commissionCents: { ...money, description: 'Comissão gerada pelos procedimentos realizados no mês.' },
      paidCents: { ...money, description: 'Repasses pagos aos dentistas no mês.' },
      balanceAtEndCents: { type: 'integer', description: 'O que a clínica devia aos dentistas no último dia do mês.' },
    }),
    resultCents: { type: 'integer', description: 'Caixa líquido menos repasses pagos.' },
    dentists: { type: 'array', items: obj({ dentist: obj({ id: uuid, name: str }), proceduresCount: int, producedCents: money, commissionCents: money, attendedCount: int }) },
  }),
  EvolucaoMensal: obj({
    data: { type: 'array', items: obj({ month: str, receivedCents: money, refundedCents: money, producedCents: money, payoutsPaidCents: money, newPatients: int }) },
  }),

  Imagem: obj({
    id: uuid, patientId: uuid,
    kind: enumOf(IMAGE_KINDS, 'xray = radiografia; photo = foto clínica; document = documento/laudo; other = outro.'),
    tooth: { ...nint, description: 'Dente relacionado (FDI), quando houver.' },
    takenOn: date, notes: nstr,
    format: enumOf(IMAGE_FORMATS), bytes: int, width: nint, height: nint, uploadedBy: nuuid, createdAt: dateTime,
    url: { type: 'string', description: 'Link para baixar o original. Expira em `urlExpiresAt`: peça outro quando precisar.' },
    urlExpiresAt: dateTime,
  }),
  AssinaturaUpload: obj({
    publicId: { type: 'string', description: 'Identificador do arquivo no armazenamento. Envie-o no registro depois do upload.' },
    uploadUrl: { type: 'string', description: 'Endereço do Cloudinary para o envio (POST multipart).' },
    fields: obj({
      public_id: str, type: str, allowed_formats: str, timestamp: int, api_key: str, signature: str,
    }, 'Campos que o app deve enviar junto com o arquivo (`file`), exatamente como vieram.'),
    allowedFormats: { type: 'array', items: enumOf(IMAGE_FORMATS) },
    maxBytes: { type: 'integer', description: 'Tamanho máximo aceito no registro.' },
    validForSeconds: { type: 'integer', description: 'Por quanto tempo a assinatura vale.' },
  }),

  ConfigAvisos: obj({
    remindersEnabled: { type: 'boolean', description: 'Liga o lembrete automático de consulta.' },
    reminderHoursBefore: { type: 'integer', description: 'Com quantas horas de antecedência o lembrete é enviado (1 a 72).' },
    contactPhone: { ...nstr, description: 'Telefone da clínica que aparece nos avisos.' },
    contactAddress: { ...nstr, description: 'Endereço da clínica que aparece nos avisos.' },
  }),
  Aviso: obj({
    id: uuid,
    kind: enumOf(NOTIFICATION_KINDS, 'appointment_reminder = lembrete de consulta; budget = orçamento.'),
    channel: enumOf(['email']),
    trigger: enumOf(NOTIFICATION_TRIGGERS, 'auto = enviado pelo agendador; manual = enviado por alguém da equipe.'),
    patient: obj({ id: uuid, name: str }), appointmentId: nuuid, budgetId: nuuid, recipient: str, subject: str,
    status: enumOf(NOTIFICATION_STATUSES, 'pending = enviando; sent = enviado; failed = falhou (veja lastError).'),
    attempts: int, lastError: nstr, sentAt: nDateTime, createdAt: dateTime,
  }),
  ResumoLembretes: obj({
    alreadyRunning: { type: 'boolean', description: 'true = outra execução estava em andamento e esta não fez nada.' },
    clinics: { type: 'integer' }, considered: { type: 'integer', description: 'Atendimentos dentro da janela do lembrete.' },
    sent: int, failed: int,
    skipped: obj({ noEmail: int, noConsent: int, alreadyHandled: int }),
  }),
  LinkWhatsapp: obj({
    phone: { type: 'string', description: 'Telefone do paciente com DDI 55.' },
    message: { type: 'string', description: 'Mensagem pronta.' },
    url: { type: 'string', description: 'Link wa.me: abre o WhatsApp com a mensagem pronta; a pessoa só confirma o envio.' },
  }),

  MarcacaoDente: obj({
    id: uuid, tooth: int, faces: nstr, condition: enumOf(CONDITIONS), notes: nstr, recordedOn: date,
    recordedBy: uuid, sourceItemId: { ...nuuid, description: 'Item de orçamento que gerou a marcação, quando foi automática.' }, createdAt: dateTime,
  }),
  Odontograma: obj({
    patientId: uuid,
    teeth: { type: 'object', description: 'Marcações atuais agrupadas pelo número do dente (FDI).', additionalProperties: array('MarcacaoDente') },
  }),
};
