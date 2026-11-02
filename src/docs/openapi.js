// Gera a especificação OpenAPI 3.1 a partir do próprio código: rotas, perfis, autenticação e schemas de entrada vêm das rotas
// (ver discover.js); os textos e os schemas de resposta vêm de descriptions.js e schemas.js.
import { readFileSync } from 'node:fs';
import { z } from '../config/zod.js';
import { isOpenWhenSuspended } from '../modules/billing/access.js';
import { DOCS } from './descriptions.js';
import { listRoutes } from './discover.js';
import { ref, SCHEMAS } from './schemas.js';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const PATTERN_FORMATS = new Set(['date', 'date-time', 'uuid', 'email']);

/** Limpa o JSON Schema gerado pelo zod: tira o $schema, os padrões gigantes de datas/uuid e o máximo inteiro do JavaScript. */
export function cleanSchema(node) {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema') continue;
    if (key === 'pattern' && PATTERN_FORMATS.has(node.format)) continue;
    if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue;
    out[key] = cleanSchema(value);
  }
  return out;
}

const toJsonSchema = (schema) => cleanSchema(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }));

const ROLE_NAMES = { admin: 'administrador', secretary: 'secretária', dentist: 'dentista' };

const TAGS = [
  ['Autenticação', 'Entrada, renovação de sessão, verificação de e-mail e senha.'],
  ['Cadastro', 'Cadastro público de clínicas (autoatendimento), modelos e textos legais (Termos de Uso e Política de Privacidade).'],
  ['Assinatura', 'Teste grátis, plano, faturas e pagamento por Pix da clínica.'],
  ['Conta', 'LGPD: exportar os dados da clínica e pedir a exclusão da conta.'],
  ['Clínica', 'Dados da própria clínica e primeiros passos.'],
  ['Usuários', 'Gestão dos usuários da clínica (administrador).'],
  ['Dentistas', 'Dados profissionais dos dentistas.'],
  ['Procedimentos', 'Tabela de procedimentos e preços.'],
  ['Pacientes', 'Cadastro e ficha dos pacientes.'],
  ['Imagens', 'Radiografias, fotos e documentos do paciente (armazenados no Cloudinary, privados).'],
  ['Odontograma', 'Marcações por dente do paciente.'],
  ['Agenda', 'Atendimentos agendados.'],
  ['Orçamentos', 'Orçamentos, itens, aprovação e execução dos procedimentos.'],
  ['Pagamentos', 'Recebimentos, parcelas, contas a receber e inadimplência.'],
  ['Repasse', 'Repasse aos dentistas: configuração, regras, lançamentos, saldos e fechamentos (só administração).'],
  ['Avisos', 'Lembretes de consulta, orçamento por e-mail e links de WhatsApp para o paciente.'],
  ['Relatórios', 'Relatórios gerenciais mensais (só administração).'],
  ['Plataforma', 'Administração do sistema: clínicas (só o dono da plataforma).'],
];

function tagFor({ path }) {
  if (path.includes('/odontogram')) return 'Odontograma';
  if (path.includes('/images')) return 'Imagens';
  if (path.includes('/payment')) return 'Pagamentos';
  const group = path.split('/')[2];
  return {
    auth: 'Autenticação', signup: 'Cadastro', legal: 'Cadastro', billing: 'Assinatura', account: 'Conta', clinic: 'Clínica', users: 'Usuários', dentists: 'Dentistas', procedures: 'Procedimentos',
    patients: 'Pacientes', appointments: 'Agenda', budgets: 'Orçamentos', payouts: 'Repasse', reports: 'Relatórios', notifications: 'Avisos', platform: 'Plataforma',
  }[group];
}

const errorResponse = (description) => ({ description, content: { 'application/json': { schema: ref('Erro') } } });

function parametersFrom(location, schema) {
  const json = toJsonSchema(schema);
  return Object.entries(json.properties).map(([name, property]) => ({
    name, in: location, required: location === 'path' || (json.required ?? []).includes(name), schema: property,
  }));
}

function responsesFor(route, doc) {
  const responses = {
    [doc.status]: doc.response
      ? { description: 'Sucesso.', content: { 'application/json': { schema: doc.response } } }
      : { description: 'Sucesso, sem conteúdo.' },
    400: errorResponse('Dados inválidos (`details` lista os campos) ou JSON malformado.'),
    429: errorResponse('Muitas requisições deste IP. Veja `Retry-After`.'),
    500: errorResponse('Erro interno.'),
  };
  if (route.schemas.body) responses[413] = errorResponse('Corpo da requisição grande demais.');
  if (route.auth) {
    responses[401] = errorResponse('Não autenticado: token ausente, inválido, expirado ou de sessão encerrada.');
    if (route.auth === 'clinic' && !isOpenWhenSuspended(route.method, route.path)) {
      responses[402] = errorResponse('Assinatura da clínica suspensa ou cancelada (`SUBSCRIPTION_SUSPENDED`). Só a tela de assinatura, a exportação dos dados, o login e a leitura da clínica seguem liberados.');
    }
    responses[403] = errorResponse('Sem permissão para esta ação, ou conta sem acesso (e-mail não verificado, usuário desativado ou clínica suspensa).');
  }
  if (route.path.includes(':')) responses[404] = errorResponse('Recurso não encontrado. Recursos de outra clínica também respondem 404, para não revelar que existem.');
  for (const [status, description] of Object.entries(doc.errors ?? {})) responses[status] = errorResponse(description);
  return responses;
}

function accessText(route) {
  if (route.auth === 'platform') return 'Acesso: administradores da plataforma.';
  if (route.auth === 'clinic') return `Acesso: ${(route.roles ?? Object.keys(ROLE_NAMES)).map((role) => ROLE_NAMES[role]).join(', ')}.`;
  return 'Acesso: público (não exige login).';
}

function operationFor(route, doc) {
  const parameters = [
    ...(route.schemas.params ? parametersFrom('path', route.schemas.params) : []),
    ...(route.schemas.query ? parametersFrom('query', route.schemas.query) : []),
  ];
  return {
    operationId: `${route.method.toLowerCase()}${route.openApiPath.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))}`,
    summary: doc.summary,
    description: [doc.description, accessText(route)].filter(Boolean).join('\n\n'),
    tags: [tagFor(route)],
    security: { clinic: [{ clinicBearer: [] }], platform: [{ platformBearer: [] }] }[route.auth] ?? [],
    ...(parameters.length > 0 && { parameters }),
    ...(route.schemas.body && { requestBody: { required: true, content: { 'application/json': { schema: toJsonSchema(route.schemas.body) } } } }),
    responses: responsesFor(route, doc),
  };
}

const INFO_DESCRIPTION = `API do OdontoApp: sistema multi-clínica de gestão odontológica (web da secretária/administração e app do dentista).

## Como usar
1. A clínica se cadastra sozinha (\`POST /api/signup\`, com aceite dos Termos) e começa em **teste grátis**; o dono da plataforma também pode cadastrá-la (\`POST /api/platform/clinics\`). O primeiro administrador recebe um e-mail de verificação.
2. Cada usuário **confirma o e-mail** (\`POST /api/auth/verify-email\`) e entra (\`POST /api/auth/login\`).
3. Envie o \`accessToken\` em todas as chamadas: \`Authorization: Bearer <accessToken>\`. Ele dura pouco; renove com \`POST /api/auth/refresh\`.

## Convenções
- **Perfis:** \`admin\` (administrador da clínica), \`secretary\` (secretária) e \`dentist\` (dentista). Cada rota informa quem pode chamá-la.
- **Isolamento:** cada clínica só enxerga os próprios dados. Ids de outra clínica respondem **404**, nunca 403, para não revelar que existem. 403 é "você não pode fazer isto".
- **Erros:** sempre \`{ "error": "mensagem" }\`, às vezes com \`code\` (regra de negócio) e \`details\` (campos inválidos).
- **Listas paginadas:** \`?page=1&perPage=20\` → \`{ data, page, perPage, total, totalPages }\`.
- **Dinheiro:** sempre em **centavos** (inteiros).
- **Datas:** instantes em ISO 8601 (\`2026-11-03T13:00:00.000Z\`); datas de calendário como \`AAAA-MM-DD\` no horário de Brasília.
- **Telefone e CPF:** aceitam máscara; são guardados e devolvidos só com dígitos.
- **Limite de requisições:** excesso responde 429 com \`Retry-After\`.`;

/** Monta o documento OpenAPI. Falha se alguma rota estiver sem texto ou se sobrar texto de rota que não existe. */
export function buildOpenApi({ routes = listRoutes(), docs = DOCS } = {}) {
  const known = new Set(routes.map((route) => `${route.method} ${route.path}`));
  const stale = Object.keys(docs).filter((key) => !known.has(key));
  if (stale.length > 0) throw new Error(`Documentação de rota que não existe: ${stale.join(', ')}`);

  const paths = {};
  for (const route of routes) {
    const doc = docs[`${route.method} ${route.path}`];
    if (!doc) throw new Error(`Rota sem documentação: ${route.method} ${route.path}`);
    (paths[route.openApiPath] ??= {})[route.method.toLowerCase()] = operationFor(route, doc);
  }

  return {
    openapi: '3.1.0',
    info: { title: 'OdontoApp API', version, description: INFO_DESCRIPTION },
    servers: [{ url: '/', description: 'Este servidor' }],
    tags: TAGS.map(([name, description]) => ({ name, description })),
    paths,
    components: {
      securitySchemes: {
        clinicBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Token de acesso de usuário da clínica (`accessToken` do login).' },
        platformBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Token do administrador da plataforma (`token` de `/api/platform/login`).' },
      },
      schemas: SCHEMAS,
    },
  };
}
