// Pix do dono da plataforma: normaliza a chave configurada (BILLING_PIX_KEY) e monta o "copia e cola" / QR code estático
// (BR Code, padrão EMV do Banco Central). Não há gateway: o dinheiro cai direto na chave e quem confirma é o dono da plataforma.
//
// Formato exigido de cada tipo de chave dentro do QR:
//   CPF/CNPJ  só dígitos (CNPJ pode ter letras desde 2026)    E-mail  minúsculas
//   Telefone  +55 + DDD + número (ex.: +5535999991234)         Aleatória  UUID em minúsculas

const onlyDigits = (s) => s.replace(/\D/g, '');
const HINTS = ['CPF', 'CNPJ', 'PHONE', 'EMAIL', 'RANDOM'];
export const PIX_KEY_TYPES = HINTS;

// ---- validações de cada tipo -----------------------------------------------------------------

function isValidCpf(d) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

// CNPJ com dígitos ou letras (valor de cada caractere = código ASCII - 48), mesma conta do CNPJ numérico
function isValidCnpj(c) {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const val = (ch) => ch.charCodeAt(0) - 48;
  const dv = (len) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += val(c[i]) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}

// celular brasileiro: DDD (11 a 99) + 9 + 8 dígitos
const isMobile = (local) => /^[1-9][1-9]9\d{8}$/.test(local);

const isEmail = (s) => s.length <= 77 && /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s);
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const dashUuid = (s) => {
  const h = s.replace(/-/g, '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

// ---- interpretações possíveis do texto digitado ------------------------------------------------

function candidatesOf(raw) {
  const s = raw.trim();
  const out = [];
  const add = (type, key) => { out.push({ type, key }); };

  if (s.includes('@')) {
    if (isEmail(s)) add('EMAIL', s.toLowerCase());
    return out;
  }
  if (UUID.test(s)) {
    add('RANDOM', dashUuid(s));
    return out;
  }

  if (s.startsWith('+')) {
    const d = onlyDigits(s);
    if (d.startsWith('55') && isMobile(d.slice(2))) add('PHONE', `+${d}`);
    return out;
  }

  const compact = s.replace(/[\s.\-/()]/g, '');
  if (!compact || /[^0-9A-Za-z]/.test(compact)) return out;

  const upper = compact.toUpperCase();
  if (isValidCnpj(upper)) add('CNPJ', upper);

  if (/^\d+$/.test(compact)) {
    if (isValidCpf(compact)) add('CPF', compact);
    if (compact.length === 11 && isMobile(compact)) add('PHONE', `+55${compact}`);
    if (compact.length === 13 && compact.startsWith('55') && isMobile(compact.slice(2))) add('PHONE', `+${compact}`);
  }
  return out;
}

// A formatação usada na digitação costuma resolver a dúvida entre CPF e telefone
// (123.456.789-09 é CPF; (35) 99999-1234 é telefone).
function narrowByFormat(raw, list) {
  const s = raw.trim();
  if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(s)) return list.filter((c) => c.type === 'CPF');
  if (/[()]/.test(s) || /^\d{2}\s\d{5}[-\s]?\d{4}$/.test(s)) return list.filter((c) => c.type === 'PHONE');
  return list;
}

/**
 * Converte o que a loja digitou na forma que vai dentro do QR.
 *   normalizePixKey('123.456.789-09')   -> { ok: true, key: '12345678909', type: 'CPF' }
 *   normalizePixKey('(35) 99999-1234')  -> { ok: true, key: '+5535999991234', type: 'PHONE' }
 *   normalizePixKey('35999991234')      -> ambígua se também for um CPF válido; use `hint` ('CPF' | 'PHONE' ...)
 */
export function normalizePixKey(raw, hint = null) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, code: 'PIX_KEY_EMPTY', message: 'Informe a chave Pix.' };
  if (text.length > 140) return { ok: false, code: 'PIX_KEY_INVALID', message: 'Chave Pix longa demais.' };

  const all = candidatesOf(text);
  let list;
  if (hint) {
    if (!HINTS.includes(hint)) return { ok: false, code: 'PIX_KEY_INVALID', message: 'Tipo de chave Pix inválido.' };
    list = all.filter((c) => c.type === hint);
  } else {
    list = narrowByFormat(text, all);
  }

  if (list.length === 1) return { ok: true, ...list[0] };
  if (list.length > 1) {
    return {
      ok: false,
      code: 'PIX_KEY_AMBIGUOUS',
      message: 'Esta chave pode ser um CPF ou um telefone. Informe qual é o tipo.',
      candidates: list,
    };
  }
  return {
    ok: false,
    code: 'PIX_KEY_INVALID',
    message: hint
      ? 'A chave não confere com o tipo informado.'
      : 'Não consegui entender essa chave Pix. Confira se é um CPF, CNPJ, telefone com DDD, e-mail ou chave aleatória válidos.',
  };
}

// ---- BR Code ---------------------------------------------------------------------------------

// CRC16/CCITT-FALSE (polinômio 0x1021, valor inicial 0xFFFF), exigido no último campo (63).
export function crc16(text) {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i += 1) {
    crc ^= text.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function field(id, value) {
  const text = String(value);
  if (text.length > 99) throw new Error(`Campo ${id} do BR Code excede 99 caracteres`);
  return `${id}${String(text.length).padStart(2, '0')}${text}`;
}

// Nome/cidade do QR: sem acentos, caixa alta, só letras, números e espaço.
export function sanitizeText(value, max) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Identificador da transação: 1 a 25 caracteres alfanuméricos.
export function sanitizeTxid(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
}

/** Gera o "Pix copia e cola" (também é o conteúdo do QR). `key` já normalizada; `amountCents` em centavos. */
export function buildPixPayload({ key, name, city, amountCents, txid }) {
  if (!key) throw new Error('Chave Pix obrigatória');
  const cents = Number(amountCents);
  if (!Number.isInteger(cents) || cents <= 0 || cents > 99999999) throw new Error('Valor do Pix inválido');

  const account = field('00', 'br.gov.bcb.pix') + field('01', key);
  if (account.length > 99) throw new Error('Chave Pix longa demais para o BR Code');

  const body =
    field('00', '01') + // versão do payload
    field('01', '11') + // QR estático (reutilizável)
    field('26', account) +
    field('52', '0000') +
    field('53', '986') + // BRL
    field('54', (cents / 100).toFixed(2)) +
    field('58', 'BR') +
    field('59', sanitizeText(name, 25) || 'RECEBEDOR') +
    field('60', sanitizeText(city, 15) || 'BRASIL') +
    field('62', field('05', sanitizeTxid(txid)));

  const withCrcHeader = `${body}6304`;
  return withCrcHeader + crc16(withCrcHeader);
}

/** Lê o primeiro nível do BR Code (testes e depuração). */
export function parsePixPayload(payload) {
  const result = {};
  let i = 0;
  while (i < payload.length) {
    const id = payload.slice(i, i + 2);
    const length = Number(payload.slice(i + 2, i + 4));
    result[id] = payload.slice(i + 4, i + 4 + length);
    i += 4 + length;
  }
  return result;
}
