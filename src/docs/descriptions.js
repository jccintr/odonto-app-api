// Textos da documentação, por rota (chave = "MÉTODO /caminho" como no Express). Entrada, perfis e autenticação NÃO ficam aqui:
// vêm do código (schemas zod e middlewares). Aqui só entram resumo, regras de negócio, resposta de sucesso e erros específicos.
import { array, page, ref } from './schemas.js';

const E401_LOGIN = 'E-mail ou senha inválidos.';
const E403_ACCESS = 'Conta sem acesso: `EMAIL_NOT_VERIFIED` (e-mail ainda não confirmado), `USER_INACTIVE` (usuário desativado) ou `CLINIC_SUSPENDED` (clínica suspensa).';
const E503_STORAGE = 'Armazenamento de imagens não configurado (`STORAGE_NOT_CONFIGURED`).';
const E404_REF = 'Paciente, dentista ou procedimento não encontrado (ou de outra clínica).';

export const DOCS = {
  // ---------------- autenticação ----------------
  'POST /api/auth/login': {
    summary: 'Entrar', status: 200, response: ref('Sessao'),
    description: 'Entra com e-mail e senha. **Só entra quem já confirmou o e-mail.** Depois de 5 erros seguidos (mesmo IP e e-mail) o acesso trava por alguns minutos.',
    errors: { 401: E401_LOGIN, 403: E403_ACCESS },
  },
  'POST /api/auth/refresh': {
    summary: 'Renovar a sessão', status: 200, response: ref('Sessao'),
    description: 'Troca o refresh token por uma sessão nova (o antigo deixa de valer). Se um refresh token já usado aparecer de novo, assume-se vazamento e **todas as sessões do usuário são encerradas**.',
    errors: { 401: 'Refresh token inválido, expirado ou já usado.', 403: E403_ACCESS },
  },
  'POST /api/auth/logout': { summary: 'Sair', status: 204, description: 'Revoga o refresh token. Responde 204 mesmo que o token não exista.' },
  'POST /api/auth/verify-email': {
    summary: 'Confirmar o e-mail', status: 200, response: ref('Mensagem'),
    description: 'Confirma o e-mail com o token do link enviado por e-mail (uso único, vale 24 horas). Obrigatório no primeiro acesso.',
  },
  'POST /api/auth/resend-verification': {
    summary: 'Reenviar o link de verificação', status: 200, response: ref('Mensagem'),
    description: 'Público, porque quem não verificou o e-mail não consegue entrar. **Responde sempre igual**, exista o e-mail ou não; só envia para conta ativa, de clínica ativa, ainda não verificada e fora do intervalo mínimo entre envios.',
  },
  'POST /api/auth/forgot-password': {
    summary: 'Pedir a redefinição de senha', status: 200, response: ref('Mensagem'),
    description: 'Envia um link de uso único por e-mail. **Responde sempre igual**, exista o e-mail ou não (não revela quem tem conta).',
  },
  'POST /api/auth/reset-password': {
    summary: 'Redefinir a senha com o link do e-mail', status: 200, response: ref('Mensagem'),
    description: 'Define a nova senha e **encerra todas as sessões abertas**. Quem recebeu o e-mail comprova o endereço, então o e-mail também passa a constar como verificado.',
  },
  'GET /api/auth/me': { summary: 'Meu perfil', status: 200, response: ref('Perfil'), description: 'Dados de quem está logado e da clínica.' },
  'POST /api/auth/change-password': {
    summary: 'Trocar a senha', status: 200, response: ref('Sessao'),
    description: 'Troca a senha de quem está logado, **encerra as outras sessões** e devolve uma sessão nova. Senha atual errada responde 400 com `code: WRONG_PASSWORD` (não 401, para o app não deslogar).',
  },

  // ---------------- clínica e usuários ----------------
  'GET /api/clinic': { summary: 'Minha clínica', status: 200, response: ref('Clinica') },
  'PATCH /api/clinic': { summary: 'Alterar minha clínica', status: 200, response: ref('Clinica'), description: 'Nome e documento. Plano e situação só a plataforma altera.' },
  'GET /api/users': { summary: 'Listar usuários', status: 200, response: page('Usuario'), description: 'Só da própria clínica, em ordem de nome.' },
  'POST /api/users': {
    summary: 'Criar usuário', status: 201, response: ref('Usuario'),
    description: 'Cria o usuário e envia o e-mail de verificação (o usuário só entra depois de confirmar). Perfil `dentist` ganha automaticamente o perfil profissional em Dentistas.',
    errors: { 409: 'E-mail já cadastrado (o e-mail é único em todo o sistema).' },
  },
  'GET /api/users/:id': { summary: 'Consultar usuário', status: 200, response: ref('Usuario') },
  'PATCH /api/users/:id': {
    summary: 'Alterar usuário', status: 200, response: ref('Usuario'),
    description: 'Nome, perfil e situação (`active`). Desativar encerra as sessões do usuário. O administrador não pode se desativar nem se rebaixar.',
    errors: { 422: 'O administrador não pode desativar nem alterar o próprio perfil.' },
  },

  // ---------------- dentistas e procedimentos ----------------
  'GET /api/dentists': { summary: 'Listar dentistas', status: 200, response: array('Dentista'), description: 'Usuários com perfil `dentist` e seus dados profissionais.' },
  'GET /api/dentists/:id': { summary: 'Consultar dentista', status: 200, response: ref('Dentista') },
  'PATCH /api/dentists/:id': { summary: 'Alterar dados profissionais do dentista', status: 200, response: ref('Dentista'), description: 'CRO, especialidade, cor da agenda e percentual de repasse padrão.' },
  'GET /api/procedures': { summary: 'Listar procedimentos', status: 200, response: page('Procedimento'), description: 'Tabela de procedimentos e preços da clínica.' },
  'GET /api/procedures/:id': { summary: 'Consultar procedimento', status: 200, response: ref('Procedimento') },
  'POST /api/procedures': {
    summary: 'Cadastrar procedimento', status: 201, response: ref('Procedimento'),
    description: 'Preço em centavos. `odontogramCondition` define a marcação que o dente recebe quando o procedimento é realizado.',
    errors: { 409: 'Já existe um procedimento com este nome.' },
  },
  'PATCH /api/procedures/:id': {
    summary: 'Alterar procedimento', status: 200, response: ref('Procedimento'),
    description: 'Para tirar um procedimento de uso, desative (`active: false`) em vez de excluir.',
    errors: { 409: 'Já existe um procedimento com este nome.' },
  },

  // ---------------- pacientes e odontograma ----------------
  'GET /api/patients': {
    summary: 'Listar pacientes', status: 200, response: page('PacienteResumo'),
    description: 'Formato resumido. `q` busca por nome, CPF ou telefone.',
  },
  'GET /api/patients/:id': { summary: 'Ficha do paciente', status: 200, response: ref('Paciente'), description: 'Ficha completa. **Cada consulta é registrada na auditoria.**' },
  'POST /api/patients': {
    summary: 'Cadastrar paciente', status: 201, response: ref('Paciente'),
    description: 'Só o nome é obrigatório. CPF (validado) e telefone aceitam máscara e são guardados só com dígitos.',
    errors: { 409: 'CPF já cadastrado nesta clínica.' },
  },
  'PATCH /api/patients/:id': {
    summary: 'Alterar paciente', status: 200, response: ref('Paciente'),
    description: 'Campos opcionais; `null` limpa um campo; `address` altera só as partes enviadas. Não existe exclusão: arquive com `active: false`.',
    errors: { 409: 'CPF já cadastrado nesta clínica.' },
  },
  'GET /api/patients/:patientId/odontogram': { summary: 'Odontograma do paciente', status: 200, response: ref('Odontograma'), description: 'Marcações atuais agrupadas por dente. Cada leitura é registrada na auditoria.' },
  'POST /api/patients/:patientId/odontogram': { summary: 'Marcar dente', status: 201, response: ref('MarcacaoDente'), description: 'Marcação manual. Dente na numeração FDI; faces V, L, M, D, O.' },
  'DELETE /api/patients/:patientId/odontogram/:recordId': { summary: 'Remover marcação', status: 204, description: 'Remoção lógica: a marcação sai do odontograma, mas fica registrada (quem removeu e quando).' },

  // ---------------- imagens e radiografias ----------------
  'GET /api/patients/:patientId/images': {
    summary: 'Imagens do paciente', status: 200, response: page('Imagem'),
    description: 'Da mais recente para a mais antiga (data da imagem). Cada item traz um link de download que expira (`url`). **A consulta é auditada.**',
    errors: { 503: E503_STORAGE },
  },
  'POST /api/patients/:patientId/images/upload-signature': {
    summary: 'Passo 1: assinar o envio da imagem', status: 200, response: ref('AssinaturaUpload'),
    description: 'O app envia o arquivo **direto ao Cloudinary** (POST multipart em `uploadUrl`, com os `fields` devolvidos e o `file`); a API não recebe o arquivo. Depois, registre a imagem com `POST /api/patients/:patientId/images`.',
    errors: { 503: 'Armazenamento de imagens não configurado (`STORAGE_NOT_CONFIGURED`).' },
  },
  'POST /api/patients/:patientId/images': {
    summary: 'Passo 2: registrar a imagem enviada', status: 201, response: ref('Imagem'),
    description: 'Informe o `publicId` recebido na assinatura. A API confere no armazenamento que o arquivo existe, é deste paciente e cabe no tamanho máximo, e guarda formato e tamanho reais (não os que o app informa). Arquivo grande demais é apagado.',
    errors: {
      404: 'Paciente não encontrado (ou de outra clínica).',
      409: 'Imagem já registrada (`IMAGE_ALREADY_REGISTERED`).',
      422: 'Arquivo de outro paciente (`INVALID_PUBLIC_ID`), não enviado ainda (`UPLOAD_NOT_FOUND`) ou acima do limite (`FILE_TOO_LARGE`).',
      502: 'Falha ao consultar o armazenamento (`STORAGE_ERROR`).', 503: 'Armazenamento de imagens não configurado (`STORAGE_NOT_CONFIGURED`).',
    },
  },
  'GET /api/patients/:patientId/images/:imageId': { summary: 'Consultar imagem', status: 200, response: ref('Imagem'), description: 'Com links novos de download. A consulta é auditada.', errors: { 503: E503_STORAGE } },
  'PATCH /api/patients/:patientId/images/:imageId': { summary: 'Alterar dados da imagem', status: 200, response: ref('Imagem'), description: 'Tipo, dente, data e observações. O arquivo não muda.', errors: { 503: E503_STORAGE } },
  'DELETE /api/patients/:patientId/images/:imageId': {
    summary: 'Remover imagem', status: 204,
    description: 'Apaga o arquivo no armazenamento e marca o registro como removido (fica registrado quem removeu e quando).',
    errors: { 502: 'Não foi possível apagar no armazenamento; nada foi alterado (`STORAGE_ERROR`).', 503: E503_STORAGE },
  },

  'GET /api/appointments': {
    summary: 'Listar atendimentos', status: 200, response: page('Atendimento'),
    description: 'Entra quem encosta no intervalo [`from`, `to`). O dentista só vê a própria agenda.',
  },
  'GET /api/appointments/:id': { summary: 'Consultar atendimento', status: 200, response: ref('Atendimento') },
  'POST /api/appointments': {
    summary: 'Agendar', status: 201, response: ref('Atendimento'),
    description: 'Datas em ISO 8601 com fuso. Para o perfil dentista, `dentistId` é opcional (vale a própria agenda).',
    errors: {
      404: E404_REF, 409: 'Horário indisponível (`SLOT_TAKEN`): o dentista já tem atendimento ativo neste período.',
      422: 'Paciente arquivado ou dentista desativado.',
    },
  },
  'PATCH /api/appointments/:id': {
    summary: 'Remarcar ou editar', status: 200, response: ref('Atendimento'),
    description: 'Se só o início mudar, a duração é mantida. Mudar horário ou dentista volta o atendimento para `scheduled`. Só atendimentos agendados ou confirmados podem ser alterados.',
    errors: { 409: 'Horário indisponível (`SLOT_TAKEN`) ou atendimento já finalizado.', 422: 'Dentista de destino desativado.' },
  },
  'POST /api/appointments/:id/status': {
    summary: 'Mudar a situação do atendimento', status: 200, response: ref('Atendimento'),
    description: 'Fluxo: `scheduled` → `confirmed` → `attended`; também `no_show` e `canceled` (com `reason` opcional). Situações finais não mudam mais; cancelar libera o horário.',
    errors: { 409: 'Transição inválida (`INVALID_TRANSITION`).' },
  },

  // ---------------- orçamentos ----------------
  'GET /api/budgets': {
    summary: 'Listar orçamentos', status: 200, response: page('OrcamentoResumo'),
    description: 'Formato resumido (sem os itens), do mais novo para o mais antigo. O dentista só vê os próprios.',
  },
  'GET /api/budgets/:id': { summary: 'Consultar orçamento', status: 200, response: ref('Orcamento'), description: 'Com os itens, o subtotal e o total.' },
  'POST /api/budgets': {
    summary: 'Criar orçamento', status: 201, response: ref('Orcamento'),
    description: 'Cada item é um procedimento, opcionalmente com dente (FDI) e faces. O preço do item é copiado do procedimento (ou informado): mudar a tabela depois não altera orçamentos antigos.',
    errors: { 404: E404_REF, 422: 'Desconto maior que o valor, paciente arquivado, dentista ou procedimento desativado.' },
  },
  'PATCH /api/budgets/:id': {
    summary: 'Alterar desconto e observações', status: 200, response: ref('Orcamento'),
    errors: { 409: 'Orçamento fora de "aberto" (`BUDGET_NOT_OPEN`).', 422: 'O desconto não pode ser maior que o valor do orçamento.' },
  },
  'POST /api/budgets/:id/status': {
    summary: 'Aprovar, recusar ou reabrir', status: 200, response: ref('Orcamento'),
    description: 'Todos os perfis registram a decisão. `open` → `approved` ou `rejected`; `rejected` → `open`. Aprovado não volta. O estado `completed` é automático e não é aceito aqui.',
    errors: { 409: 'Transição inválida (`INVALID_TRANSITION`).', 422: 'Inclua ao menos um procedimento para aprovar.' },
  },
  'POST /api/budgets/:id/items': {
    summary: 'Incluir item', status: 201, response: ref('Orcamento'), description: 'Só com o orçamento em aberto. Devolve o orçamento atualizado.',
    errors: { 404: 'Orçamento ou procedimento não encontrado.', 409: 'Orçamento fora de "aberto" (`BUDGET_NOT_OPEN`).', 422: 'Procedimento desativado.' },
  },
  'PATCH /api/budgets/:id/items/:itemId': {
    summary: 'Alterar item', status: 200, response: ref('Orcamento'), description: 'Só com o orçamento em aberto. `tooth` e `faces` aceitam `null`.',
    errors: { 409: 'Orçamento fora de "aberto" (`BUDGET_NOT_OPEN`).', 422: 'Faces sem dente, ou desconto maior que o novo valor.' },
  },
  'DELETE /api/budgets/:id/items/:itemId': {
    summary: 'Remover item', status: 200, response: ref('Orcamento'), description: 'Só com o orçamento em aberto. Devolve o orçamento atualizado.',
    errors: { 409: 'Orçamento fora de "aberto" (`BUDGET_NOT_OPEN`).', 422: 'O desconto ficaria maior que o valor do orçamento.' },
  },
  'POST /api/budgets/:id/items/:itemId/perform': {
    summary: 'Realizar o procedimento', status: 200, response: ref('Orcamento'),
    description: 'Só com o orçamento aprovado. Registra **quem executou** (base do repasse): o dentista do orçamento, ou `dentistId` (o dentista só executa como ele mesmo). Se o item tem dente e o procedimento tem `odontogramCondition`, o dente é marcado automaticamente. Quando não resta item pendente, o orçamento vira `completed`.',
    errors: { 409: 'Orçamento não aprovado (`BUDGET_NOT_APPROVED`) ou item já finalizado (`ITEM_NOT_PENDING`).', 422: 'Dentista executor desativado.' },
  },
  'POST /api/budgets/:id/items/:itemId/cancel': {
    summary: 'Cancelar item (o paciente desistiu)', status: 200, response: ref('Orcamento'),
    description: 'Só com o orçamento aprovado e o item pendente. O item sai do subtotal.',
    errors: { 409: 'Orçamento não aprovado (`BUDGET_NOT_APPROVED`) ou item já finalizado (`ITEM_NOT_PENDING`).' },
  },

  // ---------------- pagamentos ----------------
  'GET /api/budgets/:id/payments': {
    summary: 'Pagamentos do orçamento', status: 200, response: ref('PagamentosDoOrcamento'),
    description: 'Lançamentos por vencimento e resumo financeiro (total, lançado, recebido, a receber, vencido e saldo sem lançamento). Cancelados não contam.',
  },
  'POST /api/budgets/:id/payments': {
    summary: 'Lançar pagamento', status: 201, response: ref('Pagamento'),
    description: 'Parcela a receber (informe `dueDate`) **ou** recebimento na hora (informe `method` e `paidAt`). Só em orçamento aprovado ou concluído; o total lançado nunca passa do total do orçamento.',
    errors: { 409: 'Orçamento não aprovado (`BUDGET_NOT_APPROVED`).', 422: 'Valor acima do saldo (`EXCEEDS_BALANCE`, com `balanceCents`).' },
  },
  'POST /api/budgets/:id/payment-plan': {
    summary: 'Gerar parcelas mensais', status: 201, response: array('Pagamento'),
    description: 'Divide o saldo do orçamento (ou `amountCents`) em parcelas mensais no mesmo dia de cada mês (dia 31 vira o último dia do mês); os centavos que sobram vão nas primeiras parcelas.',
    errors: { 409: 'Orçamento não aprovado (`BUDGET_NOT_APPROVED`).', 422: 'Sem saldo (`NO_BALANCE`), valor acima do saldo (`EXCEEDS_BALANCE`) ou menor que o número de parcelas.' },
  },
  'GET /api/payments': {
    summary: 'Contas a receber', status: 200, response: page('Pagamento'),
    description: 'Por vencimento. `overdue=true` traz só as pendentes vencidas (inadimplência).',
  },
  'GET /api/payments/:id': { summary: 'Consultar pagamento', status: 200, response: ref('Pagamento') },
  'PATCH /api/payments/:id': {
    summary: 'Alterar parcela pendente', status: 200, response: ref('Pagamento'),
    errors: { 409: 'Só parcelas pendentes podem ser alteradas (`PAYMENT_NOT_PENDING`).', 422: 'Valor acima do saldo do orçamento (`EXCEEDS_BALANCE`).' },
  },
  'POST /api/payments/:id/pay': {
    summary: 'Registrar o recebimento', status: 200, response: ref('Pagamento'), description: 'Só parcela pendente. `paidAt` é opcional (padrão: agora).',
    errors: { 409: 'Parcela não está pendente (`PAYMENT_NOT_PENDING`).' },
  },
  'POST /api/payments/:id/cancel': {
    summary: 'Cancelar ou estornar', status: 200, response: ref('Pagamento'),
    description: 'Cancela uma parcela pendente; **estornar um pagamento já recebido é só do administrador** (403 para a secretária). O valor volta para o saldo do orçamento.',
    errors: { 409: 'Pagamento já cancelado (`PAYMENT_ALREADY_CANCELED`).' },
  },

  // ---------------- repasse aos dentistas (só administração) ----------------
  'GET /api/payouts/settings': {
    summary: 'Configuração do repasse', status: 200, response: ref('ConfigRepasse'),
    description: 'Como a clínica repassa aos dentistas. Sem nada salvo, valem os padrões: liberar conforme o paciente paga, sem descontar custos nem taxas, percentual padrão 0%.',
  },
  'PATCH /api/payouts/settings': {
    summary: 'Alterar a configuração do repasse', status: 200, response: ref('ConfigRepasse'),
    description: 'A mudança vale **daqui para frente**: cada procedimento realizado congela a regra do momento, então lançamentos antigos não são recalculados.',
  },
  'GET /api/payouts/rules': { summary: 'Listar regras por exceção', status: 200, response: array('RegraRepasse') },
  'GET /api/payouts/rules/resolve': {
    summary: 'Qual regra vale?', status: 200, response: ref('RegraAplicada'),
    description: 'Mostra a regra que seria aplicada a um dentista num procedimento. Ordem, do mais específico ao mais geral: **dentista + procedimento**, **procedimento**, **percentual do dentista** (`PATCH /api/dentists/:id`), **percentual padrão da clínica**.',
    errors: { 404: 'Dentista ou procedimento não encontrado (ou de outra clínica).' },
  },
  'POST /api/payouts/rules': {
    summary: 'Criar regra por exceção', status: 201, response: ref('RegraRepasse'),
    description: 'Regra de um procedimento, para todos os dentistas ou só para o `dentistId` informado. Tipo `percent` (percentual da base) ou `fixed` (valor fixo por procedimento realizado).',
    errors: { 404: E404_REF, 409: 'Já existe regra para esse procedimento e dentista (`RULE_EXISTS`).' },
  },
  'PATCH /api/payouts/rules/:id': {
    summary: 'Alterar o valor da regra', status: 200, response: ref('RegraRepasse'),
    description: 'Troca o tipo e o valor (informe `type` e o valor correspondente). Procedimento e dentista não mudam: crie outra regra.',
  },
  'DELETE /api/payouts/rules/:id': { summary: 'Remover regra', status: 204, description: 'Não altera lançamentos já feitos: eles guardam a regra que foi aplicada.' },
  'GET /api/payouts/entries': {
    summary: 'Lançamentos de repasse', status: 200, response: page('LancamentoRepasse'),
    description: 'Um lançamento por procedimento realizado, com a comissão calculada e quanto já está liberado, pago e a pagar na data `until` (padrão: hoje).',
  },
  'GET /api/payouts/balances': {
    summary: 'Saldo por dentista', status: 200, response: ref('SaldosRepasse'),
    description: 'O que a clínica deve a cada dentista até `until` (padrão: hoje). Saldo negativo = pagamento do paciente estornado depois do repasse; será descontado no próximo fechamento.',
  },
  'GET /api/payouts': { summary: 'Listar fechamentos', status: 200, response: page('FechamentoRepasse') },
  'POST /api/payouts': {
    summary: 'Pagar o repasse ao dentista', status: 201, response: ref('FechamentoRepasseDetalhe'),
    description: 'Fecha e registra o pagamento do saldo do dentista até `until` (padrão: hoje; para fechar o mês, informe o último dia dele). Saldos negativos entram descontados. Dois fechamentos simultâneos nunca pagam o mesmo saldo duas vezes.',
    errors: { 404: 'Dentista não encontrado (ou de outra clínica).', 422: 'Sem saldo a repassar até a data (`NOTHING_TO_PAY`).' },
  },
  'GET /api/payouts/:id': { summary: 'Consultar fechamento', status: 200, response: ref('FechamentoRepasseDetalhe'), description: 'Com as linhas (procedimento, paciente e valor).' },
  'POST /api/payouts/:id/cancel': {
    summary: 'Desfazer fechamento', status: 200, response: ref('FechamentoRepasseDetalhe'),
    description: 'Use quando o pagamento ao dentista não saiu. O saldo volta aos lançamentos.',
    errors: { 409: 'Fechamento já cancelado (`PAYOUT_ALREADY_CANCELED`).' },
  },

  // ---------------- avisos ao paciente (administração e secretária) ----------------
  'GET /api/notifications/settings': { summary: 'Configuração dos avisos', status: 200, response: ref('ConfigAvisos'), description: 'Padrão: lembrete ligado, 24 horas antes.' },
  'PATCH /api/notifications/settings': { summary: 'Alterar a configuração dos avisos', status: 200, response: ref('ConfigAvisos'), description: 'Só o administrador. Telefone e endereço aparecem nos e-mails ao paciente.' },
  'GET /api/notifications': {
    summary: 'Avisos enviados', status: 200, response: page('Aviso'),
    description: 'Registro de tudo que foi enviado (ou falhou), do mais recente para o mais antigo. Filtros: paciente, tipo e situação.',
  },
  'POST /api/notifications/reminders/run': {
    summary: 'Enviar agora os lembretes desta clínica', status: 200, response: ref('ResumoLembretes'),
    description: 'Faz o mesmo que o agendador automático (`REMINDERS_SCHEDULER=true`): envia o lembrete dos atendimentos dentro da janela configurada que ainda não receberam. Falhas são tentadas de novo (até 3 vezes). Só um processo trabalha por vez.',
  },
  'POST /api/notifications/appointments/:appointmentId/reminder': {
    summary: 'Enviar o lembrete de uma consulta por e-mail', status: 201, response: ref('Aviso'),
    description: 'Para atendimento futuro e ativo, de paciente com e-mail e que autorizou contato. **Se o e-mail falhar, a resposta é 201 com `status: failed` e o motivo em `lastError`** (o registro fica no histórico). O lembrete automático não repete quem já recebeu.',
    errors: { 404: 'Atendimento não encontrado (ou de outra clínica).', 409: 'Atendimento passado ou cancelado (`APPOINTMENT_NOT_UPCOMING`).', 422: 'Paciente sem e-mail (`NO_EMAIL`) ou sem autorização de contato (`NO_CONSENT`).' },
  },
  'GET /api/notifications/appointments/:appointmentId/whatsapp': {
    summary: 'Link de WhatsApp com o lembrete pronto', status: 200, response: ref('LinkWhatsapp'),
    description: 'Gratuito: devolve um link `wa.me` com a mensagem pronta; quem clica só confirma o envio no próprio WhatsApp. Não fica registrado em avisos.',
    errors: { 404: 'Atendimento não encontrado.', 409: 'Atendimento passado ou cancelado (`APPOINTMENT_NOT_UPCOMING`).', 422: 'Paciente sem telefone (`NO_PHONE`) ou sem autorização de contato (`NO_CONSENT`).' },
  },
  'POST /api/notifications/budgets/:budgetId/email': {
    summary: 'Enviar o orçamento ao paciente por e-mail', status: 201, response: ref('Aviso'),
    description: 'Com os procedimentos vigentes, desconto e total. Funciona em qualquer situação do orçamento. Se o e-mail falhar, a resposta é 201 com `status: failed`.',
    errors: { 404: 'Orçamento não encontrado (ou de outra clínica).', 422: 'Sem procedimentos (`NO_ITEMS`), paciente sem e-mail (`NO_EMAIL`) ou sem autorização de contato (`NO_CONSENT`).' },
  },
  'GET /api/notifications/budgets/:budgetId/whatsapp': {
    summary: 'Link de WhatsApp com o orçamento pronto', status: 200, response: ref('LinkWhatsapp'),
    errors: { 404: 'Orçamento não encontrado.', 422: 'Sem procedimentos (`NO_ITEMS`), paciente sem telefone (`NO_PHONE`) ou sem autorização de contato (`NO_CONSENT`).' },
  },

  // ---------------- relatórios gerenciais (só administração) ----------------
  'GET /api/reports/monthly': {
    summary: 'Relatório gerencial do mês', status: 200, response: ref('RelatorioMensal'),
    description: 'Números do mês `month` (AAAA-MM; padrão: o mês atual), por data no fuso de Brasília: **caixa** (recebido por forma, estornos, líquido e o que vence no mês), **produção** (procedimentos realizados, valor de tabela e os mais produtivos), **agenda** (por situação, comparecimento e faltas), **orçamentos** (criados, aprovados e conversão), **pacientes novos**, **repasse** (comissão gerada, paga e saldo no fim do mês), **resultado** (caixa líquido menos repasses pagos) e o quadro **por dentista**. Taxas vêm `null` quando não há base de cálculo.',
  },
  'GET /api/reports/trend': {
    summary: 'Evolução mês a mês', status: 200, response: ref('EvolucaoMensal'),
    description: 'Os últimos `months` meses (1 a 12, padrão 6), terminando em `month` (padrão: o mês atual): recebido, estornado, produzido, repasses pagos e pacientes novos. Meses sem movimento vêm zerados.',
  },

  // ---------------- plataforma ----------------
  'POST /api/platform/login': {
    summary: 'Entrar como administrador da plataforma', status: 200, response: ref('SessaoPlataforma'),
    description: 'Usa um segredo de JWT próprio: o token da plataforma nunca vale como token de clínica, e vice-versa.',
    errors: { 401: E401_LOGIN },
  },
  'GET /api/platform/clinics': { summary: 'Listar clínicas', status: 200, response: page('Clinica') },
  'POST /api/platform/clinics': {
    summary: 'Criar clínica com o primeiro administrador', status: 201, response: ref('ClinicaCriada'),
    description: 'Cria a clínica e o administrador na mesma transação e envia o e-mail de verificação (o administrador só entra depois de confirmar). O `slug` é gerado do nome se não for informado.',
    errors: { 409: 'Slug já em uso ou e-mail do administrador já cadastrado.' },
  },
  'GET /api/platform/clinics/:id': { summary: 'Consultar clínica', status: 200, response: ref('Clinica') },
  'PATCH /api/platform/clinics/:id': {
    summary: 'Alterar clínica', status: 200, response: ref('Clinica'),
    description: 'Nome, documento, plano e situação. `status: suspended` bloqueia a clínica na hora (todas as rotas passam a responder 403 `CLINIC_SUSPENDED`).',
  },
};
