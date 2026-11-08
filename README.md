# OdontoApp — API

API do OdontoApp: sistema multi-clínica de gestão odontológica (web da secretária/administração + app Android do dentista).
Node.js 22+, Express 5, PostgreSQL, knex, JavaScript (ESM). Testes com Vitest + Supertest, **100% de cobertura**.

> Ficha técnica completa do projeto: escopo, modelo de dados, roadmap e decisões em aberto.

## Rodando

```bash
npm install
cp .env.example .env        # preencha DATABASE_URL, JWT_SECRET, JWT_SECRET_PLATFORM e SMTP_*
npm run migrate             # cria as tabelas
npm run platform-admin:create -- "Seu Nome" voce@dominio.com "senha-com-8-ou-mais"
npm run dev                 # http://localhost:3000
```

O administrador da plataforma (você) cadastra as clínicas em `POST /api/platform/clinics`; cada clínica nasce com o
primeiro administrador, que cadastra os demais usuários (secretária, dentistas).

## Demonstração (sem banco para instalar)

`npm run demo` sobe a API com um PostgreSQL **embutido** e dados de exemplo (clínica, administradora, secretária, dois dentistas, procedimentos e pacientes),
imprime a URL e os logins, e apaga tudo ao encerrar (Ctrl+C). Serve para experimentar o app web (`../web`) e é o que os testes de ponta a ponta do app web usam.

## Testes

```bash
npm test                    # roda tudo
npm run test:coverage       # + cobertura (falha se ficar abaixo de 100%)
```

Os testes usam um **PostgreSQL de verdade** (necessário para testar o isolamento por clínica). Por padrão o Vitest sobe um
PostgreSQL embutido num diretório temporário (pacote `embedded-postgres`): não precisa instalar nada. Para usar um banco seu,
defina `TEST_DATABASE_URL` (o nome do banco precisa terminar com `_test`; os testes apagam todas as tabelas).
Nenhum teste envia e-mail de verdade nem usa o SMTP configurado.

## Segurança dos acessos (matriz de testes)

`tests/security.matrix.test.js` percorre **todas as rotas** (a lista vem do próprio Express, via `MOUNTS` em `src/routes.js`) e confere:
sem token ou com token de outro escopo → 401; perfil sem permissão → exatamente 403; ids de **outra clínica** → 404 (a API não confirma que
o recurso existe), sem alterar nem vazar nada da outra clínica (compara um resumo de todas as tabelas antes e depois); o dentista não alcança
a agenda e os orçamentos de outro dentista (404) nem age em nome dele (403); e contas suspensas, desativadas, apagadas, sem e-mail verificado
ou com senha trocada são barradas em todas as rotas.

**Rota nova?** Declare a regra de acesso na tabela `ACCESS` desse arquivo: sem isso o teste falha. O mesmo vale para tabelas novas com `clinic_id`
(o teste confere o isolamento de todas automaticamente).

## Multi-tenant (isolamento por clínica)

Banco e schema únicos. Toda tabela de dados de clínica tem `clinic_id` e **Row Level Security**:

- Duas conexões lógicas: o pool "dono" (`src/db/knex.js`) **não** é filtrado e só serve para autenticação, plataforma e migrations;
  tudo que acessa dados de uma clínica passa por `withTenant(clinicId, trx => ...)` (`src/db/tenant.js`), que troca para o papel
  `odonto_app` (sujeito ao RLS) e grava a clínica na sessão só durante a transação.
- O `clinicId` vem sempre do token (`req.auth.clinicId`), nunca do corpo da requisição.
- Mesmo uma consulta esquecida sem `where clinic_id` não enxerga outra clínica, e um `INSERT` com `clinic_id` alheio é recusado.

**Para criar uma tabela nova de clínica:** na migration, crie a coluna `clinic_id` e chame `enableTenantRls(knex, 'tabela')`
(`src/db/rls.js`). O teste `tests/rls.test.js` falha se alguma tabela com `clinic_id` ficar sem RLS.

## Autenticação

- **Clínica:** `POST /api/auth/login` devolve JWT de acesso (15 min) + refresh token opaco (30 dias, guardado só como hash,
  com rotação e detecção de reuso: um token já usado que reaparece encerra todas as sessões do usuário).
- **Plataforma:** `POST /api/platform/login` com segredo de JWT próprio.
- Senha trocada ou usuário/clínica desativado derruba as sessões na hora.
- **Só entra quem verificou o e-mail.** Usuário novo (criado pela plataforma ou pelo administrador da clínica) recebe um link; antes de confirmar,
  login e refresh respondem 403 `EMAIL_NOT_VERIFIED` e o app deve oferecer "reenviar link" (`POST /api/auth/resend-verification`, público).
  Redefinir a senha pelo link do e-mail também confirma o endereço.
- Verificação de e-mail e troca de senha por link de uso único (hash no banco, validade configurável), enviados pelo SMTP da Hostinger.
- `forgot-password` responde sempre igual, exista o e-mail ou não. Login tem limite por IP e trava por IP + e-mail.

## Endpoints

| Método | Rota | Quem | Descrição |
| --- | --- | --- | --- |
| GET | `/health` | público | Situação da API e do banco |
| POST | `/api/auth/login` | público | Entrar (e-mail + senha); 403 `EMAIL_NOT_VERIFIED` se o e-mail não foi confirmado |
| POST | `/api/auth/refresh` | público | Trocar o refresh token por uma sessão nova |
| POST | `/api/auth/logout` | público | Revogar o refresh token |
| GET | `/api/auth/me` | logado | Perfil do usuário e da clínica |
| POST | `/api/auth/verify-email` | público | Confirmar o e-mail com o token do link |
| POST | `/api/auth/resend-verification` | público | Reenviar o link de verificação (responde sempre igual, exista o e-mail ou não) |
| POST | `/api/auth/forgot-password` | público | Pedir o link de redefinição de senha |
| POST | `/api/auth/reset-password` | público | Definir nova senha com o token do link |
| POST | `/api/auth/change-password` | logado | Trocar a senha (devolve sessão nova) |
| GET | `/api/clinic` | logado | Dados da própria clínica |
| PATCH | `/api/clinic` | admin | Alterar nome e documento |
| GET, POST | `/api/users` | admin | Listar (filtros e paginação) e criar usuários |
| GET, PATCH | `/api/users/:id` | admin | Consultar e alterar (nome, perfil, ativo) |
| GET | `/api/dentists`, `/api/dentists/:id` | logado | Dentistas da clínica (dados profissionais) |
| PATCH | `/api/dentists/:id` | admin | CRO, especialidade, cor da agenda e % de repasse |
| GET | `/api/procedures`, `/api/procedures/:id` | logado | Tabela de procedimentos e preços (filtros e paginação) |
| POST, PATCH | `/api/procedures`, `/api/procedures/:id` | admin | Cadastrar e alterar (preço e custo em centavos; desativar em vez de excluir) |
| GET | `/api/patients` | logado | Lista resumida (busca por nome, CPF ou telefone). **O telefone (do paciente e do responsável) vem `null` para o dentista**, que também não busca por ele |
| GET | `/api/patients/:id` | logado | Ficha completa; **cada consulta é auditada** |
| POST, PATCH | `/api/patients`, `/api/patients/:id` | logado | Cadastrar e alterar (arquivar com `active: false`; não há exclusão) |
| GET | `/api/patients/:patientId/images[/:imageId]` | logado | Imagens e radiografias do paciente (link de download que expira; consulta auditada) |
| POST | `/api/patients/:patientId/images/upload-signature` | admin, dentista | Passo 1: assinar o envio direto ao Cloudinary |
| POST | `/api/patients/:patientId/images` | admin, dentista | Passo 2: registrar a imagem enviada (a API confere o arquivo no Cloudinary) |
| PATCH, DELETE | `/api/patients/:patientId/images/:imageId` | admin, dentista | Alterar dados ou remover (apaga o arquivo; o registro fica como removido) |
| GET, POST | `/api/appointments` | logado | Agenda (filtros por período, dentista, paciente e situação) e agendamento |
| GET, PATCH | `/api/appointments/:id` | logado | Consultar e remarcar |
| POST | `/api/appointments/:id/status` | logado | Confirmar, faltar ou cancelar. **Iniciar (`in_progress`): só o dentista, e confere a adimplência do paciente (409 `PATIENT_BLOCKED`)**. **Atendido: só o dentista do atendimento, depois de iniciado, com `evolution` obrigatória**: procedimento(s) realizado(s) e os **dentes afetados** (ou boca toda), do catálogo e/ou de itens de orçamento a dar baixa; texto opcional |
| GET | `/api/patients/:patientId/evolutions` | admin, dentista | Prontuário: evoluções clínicas do paciente (auditado; a secretária não lê) |
| POST | `/api/patients/:patientId/evolutions/:id/addendum` | dentista autor | Retificar uma evolução (o registro original nunca muda; o banco só permite acrescentar) |
| GET | `/api/budgets`, `/api/budgets/:id` | logado | Orçamentos (resumo na lista; com itens, subtotal e total no detalhe) |
| POST, PATCH | `/api/budgets`, `/api/budgets/:id` | admin, dentista | Criar com itens (procedimento + dente + faces) e alterar desconto/observações |
| POST, PATCH, DELETE | `/api/budgets/:id/items[/:itemId]` | admin, dentista | Incluir, alterar e remover itens (enquanto só propostos, com o orçamento em aberto ou em tratamento) |
| POST | `/api/budgets/:id/status` | logado | Aprovar tudo de uma vez, recusar ou reabrir (a secretária registra a decisão) |
| POST | `/api/budgets/:id/approvals` | logado | Rodada de aprovação: o paciente aprova alguns itens, com desconto próprio (pode haver várias rodadas) |
| GET | `/api/worklist` | admin, secretária | Lista de trabalho da recepção: aprovados sem consulta, orçamentos sem resposta, inadimplentes com consulta |
| GET | `/api/patients/:id/treatment-items` | logado | Procedimentos aprovados e a realizar do paciente, de todos os dentistas (sem valores) |
| GET | `/api/patients/:id/standing` | admin, secretária | Situação financeira do paciente (bloqueado por inadimplência?) |
| POST | `/api/patients/:id/block-release` | admin | Liberar paciente bloqueado, com motivo e por 1 a 30 dias (exceção auditada) |
| POST | `/api/budgets/:id/items/:itemId/cancel` | admin, dentista | O paciente desistiu de um item (aprovado ou só proposto) |
| GET | `/api/patients/:id/odontogram` | logado | Odontograma atual, agrupado por dente (leitura auditada) |
| POST, DELETE | `/api/patients/:id/odontogram[/:recordId]` | admin, dentista | Marcar dente e remover marcação (remoção lógica) |
| GET, POST | `/api/budgets/:id/payments` | admin, secretária | Resumo financeiro do orçamento e lançamento de parcela a receber ou recebimento na hora |
| POST | `/api/budgets/:id/payment-plan` | admin, secretária | Gerar parcelas mensais com o saldo da rodada de aprovação |
| GET | `/api/payments`, `/api/payments/:id` | admin, secretária | Contas a receber (filtros por situação, forma, paciente, vencimento e `overdue`) |
| PATCH | `/api/payments/:id` | admin, secretária | Alterar valor, vencimento e observações de parcela pendente |
| POST | `/api/payments/:id/pay`, `/api/payments/:id/cancel` | admin, secretária | Receber e cancelar (estornar recebido: só admin) |
| GET, PATCH | `/api/payouts/settings` | admin | Como a clínica repassa: quando libera, se desconta custo e taxa de cartão, % padrão |
| GET, POST | `/api/payouts/rules` | admin | Regras por exceção (procedimento, com ou sem dentista): % ou valor fixo |
| PATCH, DELETE | `/api/payouts/rules/:id` | admin | Alterar o valor ou remover a regra |
| GET | `/api/payouts/rules/resolve` | admin | Qual regra vale para um dentista num procedimento |
| GET | `/api/payouts/entries` | admin | Lançamentos de repasse (um por procedimento realizado) com liberado, pago e saldo |
| GET | `/api/payouts/balances` | admin | Quanto a clínica deve a cada dentista até uma data |
| GET, POST | `/api/payouts` | admin | Fechamentos pagos aos dentistas; pagar o saldo |
| GET | `/api/payouts/:id` | admin | Fechamento com as linhas |
| POST | `/api/payouts/:id/cancel` | admin | Desfazer um fechamento (o saldo volta) |
| GET, PATCH | `/api/notifications/settings` | admin, secretária (consulta); admin (altera) | Lembrete ligado/desligado, horas de antecedência, telefone e endereço da clínica nos e-mails |
| GET | `/api/notifications` | admin, secretária | Histórico de avisos enviados (filtros: paciente, tipo, situação) |
| POST | `/api/notifications/appointments/:appointmentId/reminder` | admin, secretária | Lembrete da consulta por e-mail, agora |
| POST | `/api/notifications/budgets/:budgetId/email` | admin, secretária | Orçamento por e-mail |
| GET | `/api/notifications/{appointments/:appointmentId,budgets/:budgetId}/whatsapp` | admin, secretária | Link `wa.me` com a mensagem pronta (WhatsApp sem custo) |
| POST | `/api/notifications/reminders/run` | admin | Roda agora os lembretes automáticos desta clínica |
| GET | `/api/reports/monthly` | admin | Relatório gerencial do mês (`?month=AAAA-MM`): caixa, produção, agenda, orçamentos, pacientes novos, repasse, resultado e quadro por dentista |
| GET | `/api/reports/trend` | admin | Evolução mês a mês (`?months=6`) para gráficos do painel |
| POST | `/api/platform/login` | plataforma | Entrar como administrador da plataforma |
| GET, POST | `/api/platform/clinics` | plataforma | Listar e criar clínica (+ primeiro admin) |
| GET, PATCH | `/api/platform/clinics/:id` | plataforma | Consultar e alterar (inclui suspender) |

Perfis da clínica: `admin`, `secretary`, `dentist`. Erros vêm como `{ "error": "mensagem" }` (validação: `{ error, details: [{ field, message }] }`).
Listas paginadas: `?page=1&perPage=20` → `{ data, page, perPage, total, totalPages }`.

## Núcleo clínico

- **Dentistas:** o perfil profissional nasce sozinho (gatilho do banco) quando um usuário com perfil `dentist` é criado ou promovido.
  Cadastre o usuário em `POST /api/users` e edite CRO, especialidade, cor e % de repasse em `PATCH /api/dentists/:id`.
- **Pacientes:** CPF validado e único por clínica, telefone e CEP só com dígitos, aceite de contato (`contactConsent`) com data.
  A lista nunca traz anamnese nem endereço. Ler a ficha, criar e alterar geram registro em `audit_log`
  (tabela somente de inserção: a aplicação não consegue alterar nem apagar; nas alterações guarda só os **nomes** dos campos, nunca os valores).
- **Agenda:** o banco impede dois atendimentos ativos do mesmo dentista no mesmo horário (restrição de exclusão), então não há corrida entre
  duas secretárias agendando juntas; cancelar libera o horário. Admin e secretária veem tudo; o dentista só a própria agenda.
  Situações: `scheduled → confirmed → in_progress → attended`, ou `no_show` / `canceled` (finais; só antes de iniciar). O dentista **inicia** o
  atendimento e só então o conclui, com o prontuário. Quem não tem horário ainda não é atendido: veja **Adimplência** abaixo.
- **Orçamentos:** cada item é um procedimento, opcionalmente com dente (numeração FDI: 11-48 permanentes e 51-85 de leite) e faces
  (V, L, M, D, O). O preço do item é copiado da tabela de procedimentos da clínica no momento (ninguém o altera no orçamento: a negociação é o desconto da aprovação), então mudar a tabela de preços depois não altera
  orçamentos antigos. Fluxo: `open → approved | rejected` (recusado pode reabrir); aprovado só avança executando os itens e vira
  `completed` sozinho quando não resta item pendente. Subtotal ignora itens cancelados; o total nunca fica negativo.
- **Rodadas de aprovação:** o paciente não precisa aprovar tudo de uma vez. Cada vez que aprova procedimentos nasce uma rodada
  (`POST /api/budgets/:id/approvals`: itens escolhidos + desconto **daquela** rodada), sem mexer nas anteriores. Item sem rodada está
  "proposto" (`approvalId: null`): ainda pode ser editado ou removido, mas não pode ser executado nem cobrado. O orçamento fica em tratamento
  (`approved`) enquanto houver item pendente; o desconto do orçamento passa a ser a soma dos descontos das rodadas. Aprovar tudo por
  `POST /status` continua valendo (uma rodada com todos os itens e o desconto do orçamento).
- **Execução:** não existe baixa direta no orçamento. O item aprovado é executado **dentro do atendimento** (o dentista informa os itens ao
  concluir, com a evolução no prontuário). Isso guarda **quem executou** (`performedByDentistId`, base do repasse) e, se o item tem dente e o
  procedimento tem uma `odontogramCondition`, cria a marcação no odontograma. O repasse usa o desconto da rodada do item. Qualquer dentista da clínica executa o que o paciente aprovou,
  mesmo em orçamento de um colega.
- **Adimplência:** paciente com parcela pendente vencida há mais dias que a tolerância da clínica (`overdueGraceDays`, padrão 7) fica
  **bloqueado**: não ganha novos agendamentos e o dentista não inicia os atendimentos marcados (409 `PATIENT_BLOCKED`; o dentista não vê valores).
  Cancelar, remarcar e receber continuam permitidos. Pagar ou renegociar o vencimento desbloqueia sozinho; o administrador abre uma exceção com
  motivo (`POST /api/patients/:id/block-release`, 1 a 30 dias, auditada).
- **Odontograma:** histórico de marcações por dente. Nada é apagado de verdade: remover marca a linha como removida (quem e quando) e registra auditoria.
  A secretária consulta (ficha impressa), mas só admin e dentista marcam. O dentista só alcança os próprios orçamentos.
- **Pagamentos:** cada linha é uma parcela a receber (`pending`), um recebimento (`paid`, com forma e data) ou um cancelamento. Só se lança
  pagamento em orçamento aprovado ou concluído, e o total lançado (pendente + pago) não passa do total da **rodada de aprovação** (`approvalId`;
  opcional quando há uma só, `APPROVAL_REQUIRED` quando há várias). A linha do orçamento é travada na transação, então dois lançamentos
  simultâneos não estouram o saldo. Valores em centavos. Cancelar devolve o saldo.
  Parcelas mensais mantêm o mesmo dia de cada mês (dia 31 vira o último dia do mês) e os centavos que sobram vão nas primeiras parcelas.
  "Vencida" = pendente com vencimento antes de hoje no fuso da clínica (`TIMEZONE`, padrão America/Sao_Paulo). Todas as mudanças são auditadas.
  O dentista não acessa o financeiro.
- **Chaves compostas por clínica:** atendimento só aponta para paciente e dentista da mesma clínica, garantido pelo banco (FK `(clinic_id, id)`).
- A migration usa `CREATE EXTENSION btree_gist`. Em banco gerenciado, o usuário das migrations precisa poder criar essa extensão
  (é uma extensão "trusted" do PostgreSQL 13+, basta ser dono do banco).

| Quem | Dentistas | Procedimentos | Pacientes | Agenda | Orçamentos | Odontograma | Pagamentos |
| --- | --- | --- | --- | --- | --- | --- | --- |
| admin | ler e editar | ler e editar | tudo | tudo | tudo | ler e marcar | tudo (inclusive estorno) |
| secretary | ler | ler | tudo | tudo | ler e registrar decisão | só ler | tudo, menos estorno |
| dentist | ler | ler | tudo | só a própria | só os próprios | ler e marcar | sem acesso |

## Documentação da API (Swagger)

Com a API no ar, abra **`/docs`** (Swagger UI interativo, com botão *Authorize* para colar o token) ou baixe **`/openapi.json`** (OpenAPI 3.1, importável no Bruno, Insomnia, Postman).
Em produção, `DOCS_ENABLED=false` desliga as duas rotas.

A documentação é **gerada do código**, não escrita à mão:
- rotas, métodos, perfis permitidos, autenticação e esquemas de entrada vêm das próprias rotas (`validate`, `requireRole`, `authenticate`);
- textos em português e formatos de resposta ficam em `src/docs/descriptions.js` e `src/docs/schemas.js`.

Os testes impedem divergência: toda rota precisa estar documentada, os perfis documentados precisam bater com a matriz de segurança, e **toda resposta real dos testes é validada contra a documentação** (status e corpo). A `tests/journey.test.js` percorre todas as rotas com sucesso.

**Rota nova:** declare `validate`/`requireRole` normalmente, descreva-a em `src/docs/descriptions.js` e inclua-a em `tests/helpers/access.js`; os testes apontam o que faltar.

## Repasse aos dentistas

Modelado a partir do que os sistemas odontológicos brasileiros fazem (comissão em % ou valor fixo, regra geral com exceções, liberar pelo pagamento ou pela execução,
descontar custo e taxa de cartão). Tudo é configurável por clínica e **só o administrador** acessa.

- **Configuração** (`/api/payouts/settings`): `releaseOn` = `payment` (padrão: a comissão é liberada na proporção do que o paciente pagou do orçamento)
  ou `procedure` (liberada por inteiro quando o procedimento é realizado); `deductCosts` desconta o custo do procedimento (`costCents`) da base;
  `deductCardFees` desconta a taxa do cartão de crédito/débito (só em `payment` e só em comissões em %); `defaultPercent` é o % padrão da clínica.
- **Qual regra vale** (do mais específico ao mais geral): regra do **dentista no procedimento** > regra do **procedimento** > **% do dentista**
  (`PATCH /api/dentists/:id`) > **% padrão da clínica**. Regra pode ser `percent` ou `fixed` (valor por procedimento realizado).
  `GET /api/payouts/rules/resolve` mostra qual vale.
- **Base de cálculo:** preço do item, com a sua parte do desconto do orçamento (proporcional ao preço), menos o custo (se a clínica desconta, nunca acima do valor cobrado).
- **Lançamento:** ao executar o procedimento no atendimento nasce um lançamento para quem **executou**, com a regra e a comissão **congeladas**.
  Mudar configuração ou regras vale só para os próximos (como nos sistemas do mercado, não há cálculo retroativo). Lançamentos e linhas de fechamento são somente de inserção.
- **Saldo** = liberado (até a data) menos o já repassado. Pagamento do paciente estornado depois do repasse deixa o saldo negativo, que é descontado no próximo fechamento.
- **Fechamento** (`POST /api/payouts`): paga o saldo do dentista até `until` (para fechar o mês, use o último dia). `422 NOTHING_TO_PAY` se não houver saldo;
  dois fechamentos simultâneos nunca pagam o mesmo saldo duas vezes. Cancelar um fechamento devolve o saldo.
- Datas de corte seguem o fuso da clínica (`TIMEZONE`).

## Relatórios gerenciais

Só o administrador. Nada é guardado: cada consulta calcula direto das tabelas, por mês de calendário no fuso da clínica (`TIMEZONE`).

- **Caixa:** recebido no mês (por forma de pagamento), estornos feitos no mês, líquido, e o que vence no mês (no prazo x vencido). Um pagamento recebido em fevereiro e estornado
  em março conta como entrada em fevereiro e como estorno em março (o mês fechado não muda).
- **Produção:** procedimentos realizados no mês, valor de tabela (antes do desconto do orçamento) e os 5 mais produtivos.
- **Agenda:** atendimentos por situação, taxa de comparecimento e de faltas (atendidos / (atendidos + faltas); `null` sem base).
- **Orçamentos:** criados, recusados, aprovados no mês (e valor) e conversão (dos criados no mês, quantos já foram aprovados).
- **Repasse:** comissão gerada no mês, repasses pagos no mês e o saldo devido no último dia do mês. **Resultado** = caixa líquido menos repasses pagos.
- **Por dentista:** procedimentos, produção, comissão e atendimentos.
- `GET /api/reports/trend` devolve a série dos últimos meses (1 a 12), com meses sem movimento zerados.

## Imagens e radiografias (Cloudinary, plano gratuito)

Usa **só recursos do plano gratuito**: envio assinado, arquivo `private`, consulta e remoção pela API, e link de download assinado. Não há transformações (miniaturas, redimensionamento), que gastam créditos.

- **Fluxo em dois passos:** (1) `POST .../images/upload-signature` devolve `publicId`, `uploadUrl` e `fields` assinados; o app envia o arquivo **direto ao Cloudinary** (a API não recebe o arquivo);
  (2) `POST .../images` registra a imagem na ficha. Nesse passo a API consulta o Cloudinary e guarda o formato, o tamanho e as dimensões **reais**,
  recusa arquivo de outro paciente/clínica (o `publicId` precisa ser `pasta/clínica/paciente/uuid`, gerado pela API), arquivo não enviado e arquivo acima de `IMAGE_MAX_MB` (que é apagado).
- **Privacidade:** os arquivos ficam como `private` (sem URL pública). A API entrega, só a quem tem acesso à ficha, um link de download **assinado que expira** (`IMAGE_URL_TTL_SECONDS`, padrão 10 min).
  Esse link passa pela API do Cloudinary (não pelo CDN) e gasta banda: o app deve baixar a imagem só quando for exibi-la e reduzi-la no próprio aparelho.
  Recomendado: no painel do Cloudinary, em *Settings → Security*, ative **Strict transformations** (gratuito), para ninguém conseguir gerar versões derivadas da imagem por URL.
- **Limites do plano gratuito** (conferidos na documentação do Cloudinary): imagem de até **10 MB** e 25 megapixels (por isso `IMAGE_MAX_MB` vem com 10);
  **25 créditos por mês** divididos entre armazenamento (1 GB = 1 crédito), banda (1 GB = 1 crédito) e transformações; entrega de **PDF vem bloqueada** em contas gratuitas,
  então só são aceitos jpg, jpeg, png, webp e heic (laudos em papel entram como foto, tipo `document`). Radiografias ocupam espaço: acompanhe o uso no painel e, se a clínica crescer, avalie outro armazenamento.
- **Quem pode:** admin, dentista e secretária consultam; só admin e dentista enviam, alteram e removem. Leituras e alterações vão para a auditoria.
- **Remoção:** apaga o arquivo no Cloudinary e marca o registro como removido (quem e quando). Se o Cloudinary falhar, nada é alterado (502).
- Tipos: `xray` (radiografia), `photo`, `document`, `other`.
- Sem `CLOUDINARY_*` no `.env`, as rotas de imagem respondem 503 `STORAGE_NOT_CONFIGURED`. Os testes usam um armazenamento falso (nunca falam com o Cloudinary).

## Avisos ao paciente (e-mail e WhatsApp)

- **Quem recebe:** só paciente com e-mail (ou telefone, no WhatsApp) **e** que autorizou contato (`contactConsent`, LGPD). Sem isso a API responde 422 (`NO_EMAIL`, `NO_PHONE`, `NO_CONSENT`) e o lembrete automático pula o paciente.
- **Lembrete de consulta:** o agendador automático envia, por e-mail, o lembrete dos atendimentos ativos que começam dentro da janela da clínica (padrão: nas próximas 24 h; configurável de 1 a 72 h em `PATCH /api/notifications/settings`).
  Cada atendimento recebe **um** lembrete: o banco garante, e quem já recebeu o lembrete enviado à mão pela secretária não recebe outro.
  Para ligar, defina `REMINDERS_SCHEDULER=true` (e, se quiser, `REMINDERS_INTERVAL_MINUTES`, padrão 15). Com vários servidores no ar, só um trabalha por vez (trava no banco).
  O administrador também pode rodar na hora em `POST /api/notifications/reminders/run` (só a própria clínica).
- **Falhas:** todo envio fica registrado em `GET /api/notifications` (`sent`, `failed` com o motivo). O automático tenta de novo nas rodadas seguintes, até 3 tentativas; um envio "pendente" parado há mais de 15 minutos (servidor caiu) é retomado.
- **Orçamento por e-mail:** procedimentos vigentes (itens cancelados ficam de fora), desconto e total, em qualquer situação do orçamento.
- **WhatsApp sem custo:** `.../whatsapp` devolve um link `wa.me` com a mensagem pronta; quem clica só confirma o envio no próprio WhatsApp. O envio automático por WhatsApp exige um provedor pago ou não oficial e **não foi ligado**: o histórico e a regra de consentimento já estão prontos para receber esse canal depois.
- Datas e horas dos avisos saem no fuso da clínica (`TIMEZONE`). Em desenvolvimento, sem SMTP, o envio fica `failed` com "SMTP não configurado" (o texto aparece no console).

## Cadastro público, teste grátis e assinatura

Qualquer clínica se cadastra sozinha (`POST /api/signup`), escolhendo um **modelo** (`general` = Clínica geral, `orthodontics` = Ortodontia, `empty` = vazia). O cadastro cria a clínica, o primeiro administrador (que precisa confirmar o e-mail), os procedimentos do modelo e o **aceite dos Termos de Uso e da Política de Privacidade** (versão, data, IP e navegador, tabela `terms_acceptances`). Os preços dos modelos são **exemplos**: o painel lembra a clínica de conferi-los (`GET /api/clinic/onboarding`).

**Teste grátis e cobrança (igual ao Delivroo, sem gateway):**

| Situação | Quando | O que acontece |
| --- | --- | --- |
| `trial` | 14 dias após o cadastro (`TRIAL_DAYS`) | tudo liberado, sem cartão |
| `active` / `courtesy` | plano pago em dia / cortesia da plataforma | tudo liberado |
| `past_due` | até 7 dias depois do vencimento (`BILLING_GRACE_DAYS`) | segue funcionando, com aviso |
| `suspended` | passou da carência | painel responde **402** `SUBSCRIPTION_SUSPENDED`; só login, assinatura, exportação de dados e `GET /api/clinic` funcionam; lembretes aos pacientes param |
| `canceled` | 30 dias depois de suspensa (`BILLING_CANCEL_AFTER_DAYS`) | igual a suspensa, sinalizando que a conta será encerrada |

A situação é **calculada das datas** a cada requisição (nada de cron). Planos iniciais (migration): Essencial R$ 79 (1 dentista), Clínica R$ 149 (até 4), Premium R$ 249 (ilimitado); o dono altera preços em `PATCH /api/platform/plans/:id`.

**Fluxo do Pix:** a clínica escolhe o plano (`POST /api/billing/plan`) → a fatura mostra a **sua chave Pix** e o "copia e cola" com o valor (`BILLING_PIX_*` no `.env`) → ela paga e clica **Já paguei** → você recebe o aviso (`OWNER_EMAIL`), confere o Pix e confirma em `POST /api/platform/clinics/:id/invoices/:invoiceId/pay`, que libera mais 1 mês (o período emenda no anterior; se já venceu, começa hoje). A fila para conferir é `GET /api/platform/invoices?reported=true`. Também há `trial/extend` (estender teste) e `courtesy` (uso grátis) por clínica.

> Se sua chave Pix for um CPF que também parece telefone (ex.: 11 dígitos começando com DDD válido e 9), defina `BILLING_PIX_KEY_TYPE=CPF`; sem isso a fatura sai sem o "copia e cola" (`reason: PIX_KEY_AMBIGUOUS`).

**Freios contra abuso:** limite de cadastros por IP (`RATE_LIMIT_SIGNUP_MAX`), e-mails temporários recusados (`SIGNUP_BLOCKED_DOMAINS` acrescenta domínios), captcha Cloudflare Turnstile opcional (`TURNSTILE_SECRET` + `captchaToken` no cadastro) e `SIGNUP_ENABLED=false` para fechar o cadastro.

**LGPD:** `GET /api/account/export` (todos os dados da clínica, sem senhas/tokens; funciona mesmo suspensa) e `POST /api/account/deletion-request` (pede exclusão; você apaga manualmente, guardando só o que a lei exigir). Os textos legais (`GET /api/legal/terms|privacy`) são **modelos escritos sem advogado**: revise com um profissional antes de divulgar. Mudou o texto? Troque `LEGAL_VERSION` em `src/modules/legal/documents.js`.

Limite de dentistas por plano: criar, reativar ou promover alguém a dentista além do limite responde 422 `PLAN_LIMIT` (no teste não há limite).

## Estrutura

```
migrations/          migrations do knex (fundação: clínicas, usuários, tokens, RLS)
src/
  app.js, main.js    app Express e inicialização; index.js é só o ponto de entrada (npm start)
  config/            variáveis de ambiente e mensagens de validação (zod em português)
  db/                pool, withTenant, helper de RLS
  middlewares/       autenticação/perfis, validação, erros, limite de requisições
  modules/           auth, clinic, users, dentists, procedures, patients, appointments, budgets, odontogram, payments, payouts, reports, images, notifications, signup, legal, billing, account, platform (routes → service)
  services/          mailer (SMTP Hostinger), senha, tokens
  utils/             erros, DTOs, paginação, slug, limite de login
templates/emails/    modelos HTML dos e-mails
tests/               suíte completa (globalSetup sobe o PostgreSQL de teste)
```

## Próximos módulos (ver roadmap da ficha técnica)

Envio automático por WhatsApp (depende de provedor). Ainda faltam na agenda: bloqueio de horários e horário de funcionamento. Depois da API: app web da secretária e app Expo do dentista.
