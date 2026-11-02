// Termos de Uso e Política de Privacidade (LGPD). Texto-modelo escrito sem advogado: revise com um profissional antes de divulgar.
// Mudou o texto? Troque LEGAL_VERSION: o aceite de cada clínica guarda a versão aceita (tabela terms_acceptances).
import { config } from '../../config/env.js';

export const LEGAL_VERSION = '2026-11-01';
export const LEGAL_TYPES = ['terms', 'privacy'];

const section = (title, paragraphs, items = []) => ({ title, paragraphs, items });

function contact() {
  const email = config.legalContactEmail;
  return email ? `pelo e-mail ${email}` : 'pelos canais de contato informados no site e no aplicativo';
}

function terms() {
  const operator = config.legalOperatorName;
  return {
    type: 'terms',
    version: LEGAL_VERSION,
    updatedOn: LEGAL_VERSION,
    title: 'Termos de Uso',
    intro: `Estes Termos regulam o uso do OdontoApp, sistema de gestão para clínicas odontológicas operado por ${operator} ("nós"). Ao criar uma conta ou usar o sistema, a clínica ("você") declara que leu e concorda com estas regras.`,
    sections: [
      section('1. O que é o OdontoApp', [
        'O OdontoApp é um sistema online para clínicas e consultórios odontológicos: agenda, cadastro e prontuário de pacientes, odontograma, orçamentos, recebimentos, repasse aos dentistas, relatórios e avisos aos pacientes.',
        'É uma ferramenta de apoio à gestão. Ela não presta atendimento odontológico, não substitui o julgamento clínico do profissional e não é um dispositivo médico.',
      ]),
      section('2. Cadastro e conta', [
        'O cadastro deve ser feito por pessoa maior de 18 anos e capaz, com poderes para representar a clínica ou o consultório. As informações do cadastro devem ser verdadeiras e mantidas atualizadas.',
      ], [
        'O e-mail de cada usuário precisa ser confirmado antes do primeiro acesso.',
        'O administrador da clínica é responsável por criar, desativar e orientar os demais usuários (secretárias e dentistas) e por manter a senha de todos em sigilo.',
        'Tudo o que for feito com o login de um usuário é considerado feito por ele e pela clínica. Avise-nos imediatamente se suspeitar de acesso indevido.',
      ]),
      section('3. Quem cuida dos dados dos pacientes', [
        'Os dados dos pacientes são da clínica. Para a Lei Geral de Proteção de Dados (LGPD, Lei 13.709/2018), a clínica é a controladora desses dados e nós somos a operadora: tratamos os dados apenas para prestar o serviço, seguindo as instruções da clínica e estes Termos.',
        'A clínica é responsável por ter base legal para tratar os dados de seus pacientes (em regra, a tutela da saúde e a execução do contrato de atendimento), por informar os pacientes sobre o tratamento, por obter o consentimento quando ele for necessário (por exemplo, para enviar lembretes e orçamentos) e por atender aos pedidos dos titulares. O texto da Política de Privacidade descreve como protegemos esses dados.',
      ]),
      section('4. Período de teste, planos e pagamento', [
        `Toda clínica nova tem ${config.trialDays} dias de teste gratuito, sem necessidade de cartão. Durante o teste, todos os recursos ficam disponíveis.`,
        'Depois do teste, o uso continua mediante assinatura mensal de um dos planos exibidos na tela Assinatura, com o preço e o limite de dentistas de cada plano. Os preços podem ser reajustados; o reajuste vale a partir da fatura seguinte e é comunicado antes.',
        'O pagamento é feito por Pix para a chave informada na fatura. A clínica avisa o pagamento pelo sistema e nós o confirmamos manualmente; o período pago passa a valer na confirmação.',
      ], [
        `Se a fatura não for paga até o vencimento, a clínica tem ${config.graceDays} dias de carência, em que o sistema continua funcionando com aviso.`,
        'Passada a carência, o acesso é suspenso: o painel passa a mostrar apenas a tela de assinatura e a exportação dos dados, até a regularização.',
        `Se a suspensão durar mais de ${config.cancelAfterDays} dias, a conta pode ser cancelada. Mesmo suspensa ou cancelada, a clínica pode exportar seus dados.`,
        'Pagamentos já realizados não são reembolsáveis pelo período em curso, salvo quando a lei exigir de outra forma.',
      ]),
      section('5. Uso aceitável', ['É proibido, entre outras condutas:'], [
        'usar o sistema para fim ilegal ou para tratar dados sem base legal;',
        'tentar acessar dados de outra clínica, burlar a segurança, sobrecarregar o serviço ou fazer engenharia reversa;',
        'compartilhar o login com pessoas que não sejam da equipe da clínica;',
        'enviar mensagens indesejadas (spam) aos pacientes ou usar os avisos do sistema para fins que não sejam o atendimento.',
      ]),
      section('6. Prontuário e guarda de documentos', [
        'A clínica continua responsável pelas obrigações legais e éticas sobre prontuário, sigilo profissional e prazo de guarda dos documentos, conforme a legislação e as normas do Conselho Federal de Odontologia. O OdontoApp é um meio de registro e guarda, mas não substitui as obrigações do profissional.',
        'Recomendamos exportar periodicamente uma cópia dos dados (tela Conta, "Exportar meus dados").',
      ]),
      section('7. Disponibilidade e cópias de segurança', [
        'Trabalhamos para manter o sistema disponível e seguro, mas não garantimos funcionamento ininterrupto ou livre de falhas. Manutenções, problemas de provedores de internet e de infraestrutura podem causar interrupções.',
        'Mantemos cópias de segurança do banco de dados conforme as ferramentas do nosso provedor, sem prometer a recuperação de qualquer informação específica. Por isso, a exportação periódica dos dados feita pela clínica é uma proteção adicional importante.',
      ]),
      section('8. Propriedade intelectual', [
        'O software, a marca, o desenho das telas e os textos do OdontoApp são nossos ou de nossos licenciantes. Você recebe apenas o direito de uso, pessoal, intransferível e enquanto a assinatura estiver em dia. Os dados que a clínica insere continuam sendo da clínica.',
      ]),
      section('9. Limitação de responsabilidade', [
        'Na extensão permitida pela lei, não respondemos por decisões clínicas, diagnósticos, tratamentos, cobranças ou orçamentos feitos pela clínica com apoio do sistema, nem por lucros cessantes ou danos indiretos. Nossa responsabilidade total, quando houver, fica limitada ao valor pago pela clínica nos 12 meses anteriores ao fato.',
        'Nada nestes Termos exclui direitos que a lei assegure ao usuário e que não possam ser afastados por contrato.',
      ]),
      section('10. Suspensão, cancelamento e exclusão dos dados', [
        'A clínica pode parar de usar o sistema quando quiser e pedir a exclusão dos dados na tela Conta. Podemos suspender ou encerrar contas que violem estes Termos, tenham fraude ou ofereçam risco à segurança, avisando sempre que possível.',
        'Atendido o pedido de exclusão, apagamos ou anonimizamos os dados em prazo razoável, preservando apenas o que a lei nos obrigar a guardar (por exemplo, registros de cobrança e aceite destes Termos).',
      ]),
      section('11. Mudanças nestes Termos', [
        'Podemos atualizar estes Termos. Mudanças importantes serão comunicadas no sistema ou por e-mail com antecedência razoável; continuar usando depois da data de vigência significa concordar com a nova versão. A versão aceita por você fica registrada.',
      ]),
      section('12. Lei aplicável, foro e contato', [
        'Estes Termos seguem as leis do Brasil. Fica eleito o foro da comarca de Brazópolis/MG para resolver conflitos, sem prejuízo do foro que a lei assegure ao consumidor, quando aplicável.',
        `Dúvidas, pedidos e reclamações podem ser enviados ${contact()}.`,
      ]),
    ],
  };
}

function privacy() {
  const operator = config.legalOperatorName;
  return {
    type: 'privacy',
    version: LEGAL_VERSION,
    updatedOn: LEGAL_VERSION,
    title: 'Política de Privacidade',
    intro: `Esta Política explica como ${operator} ("nós") trata dados pessoais no OdontoApp, de acordo com a Lei Geral de Proteção de Dados (LGPD, Lei 13.709/2018).`,
    sections: [
      section('1. Dois papéis diferentes', [
        'Dados da própria clínica e de sua equipe (cadastro, login, cobrança): somos os controladores, ou seja, decidimos como esses dados são tratados.',
        'Dados dos pacientes que a clínica registra no sistema (cadastro, prontuário, odontograma, imagens, orçamentos, pagamentos): a controladora é a clínica; nós somos operadores e só tratamos esses dados para prestar o serviço, seguindo as instruções dela.',
      ]),
      section('2. Quais dados tratamos', [], [
        'Cadastro e acesso: nome, e-mail, senha (guardada apenas em forma criptografada irreversível), função na clínica, nome e documento da clínica.',
        'Dados dos pacientes inseridos pela clínica: identificação, contato, endereço, data de nascimento, histórico de saúde e atendimentos, odontograma, imagens e radiografias, orçamentos e pagamentos. Parte deles é dado pessoal sensível (saúde), tratado com cuidado reforçado.',
        'Registros técnicos: endereço IP, data e hora de acessos, ações realizadas (trilha de auditoria) e o aceite destes documentos (versão, data, IP e navegador).',
        'Cobrança da assinatura: faturas, valores e confirmações de pagamento. Não guardamos número de cartão; o pagamento é por Pix.',
      ]),
      section('3. Para que usamos e em que base legal', [], [
        'Prestar o serviço contratado e manter a conta (execução de contrato).',
        'Cobrar a assinatura e cumprir obrigações fiscais e legais (execução de contrato e obrigação legal).',
        'Garantir a segurança, prevenir fraudes e abusos, e provar o aceite dos Termos (legítimo interesse e exercício regular de direitos).',
        'Enviar avisos do sistema ao administrador (confirmação de e-mail, redefinição de senha, comunicados da assinatura).',
        'Para os dados dos pacientes, a base legal é definida pela clínica (em regra, a tutela da saúde e a execução do contrato de atendimento; consentimento para lembretes e orçamentos por e-mail ou WhatsApp).',
      ]),
      section('4. Com quem compartilhamos', [
        'Não vendemos dados. Usamos fornecedores de infraestrutura que tratam dados em nosso nome, apenas para operar o serviço:',
      ], [
        'hospedagem da API e do banco de dados;',
        'hospedagem do site (aplicativo web);',
        'armazenamento de imagens e radiografias (acesso privado, por links temporários);',
        'envio de e-mails (confirmação de conta, lembretes e orçamentos);',
        'verificação anti-robô no cadastro (quando ativada).',
        'Alguns desses fornecedores podem armazenar dados fora do Brasil; nesses casos, buscamos fornecedores com garantias adequadas, como prevê a LGPD.',
        'Também podemos compartilhar dados por ordem judicial ou obrigação legal.',
      ]),
      section('5. Como protegemos', [], [
        'Cada clínica só enxerga os próprios dados: o isolamento é aplicado no próprio banco de dados, além da aplicação.',
        'Conexões criptografadas (HTTPS); senhas protegidas com hash; sessões com prazo curto e renovação controlada.',
        'Perfis de acesso (administrador, secretária, dentista): cada pessoa vê apenas o que sua função exige; o dentista acessa apenas os próprios atendimentos.',
        'Registro de auditoria das ações sensíveis e limite de tentativas de login.',
        'Em caso de incidente de segurança que possa causar risco relevante, avisaremos as clínicas afetadas e a Autoridade Nacional de Proteção de Dados (ANPD), conforme a lei.',
      ]),
      section('6. Por quanto tempo guardamos', [
        'Guardamos os dados enquanto a conta estiver ativa. Depois de um pedido de exclusão ou do encerramento da conta, apagamos ou anonimizamos os dados em prazo razoável, exceto o que a lei exigir manter (por exemplo, registros de cobrança e do aceite dos Termos).',
        'Atenção: o prontuário tem prazo de guarda previsto em lei e em normas do Conselho Federal de Odontologia. A decisão de excluir esses dados é da clínica; exporte uma cópia antes de pedir a exclusão.',
      ]),
      section('7. Direitos dos titulares', [
        'A LGPD garante a qualquer pessoa, entre outros: confirmar se tratamos seus dados, acessá-los, corrigi-los, pedir anonimização, bloqueio ou eliminação, pedir a portabilidade, saber com quem os compartilhamos e revogar o consentimento.',
      ], [
        'Pacientes devem fazer o pedido à própria clínica, que é a controladora dos seus dados; nós ajudamos a clínica a atendê-lo.',
        'Administradores e usuários da clínica podem exportar os dados na tela Conta e pedir a exclusão da conta pelo sistema ou pelo nosso contato.',
      ]),
      section('8. Cookies e armazenamento no navegador', [
        'Usamos apenas o armazenamento local do navegador para manter você conectado e lembrar o tema claro ou escuro. Não usamos cookies de publicidade nem rastreamento de terceiros.',
      ]),
      section('9. Crianças e adolescentes', [
        'O cadastro de clínicas é só para maiores de 18 anos. Os dados de pacientes menores de idade são registrados pela clínica, com o consentimento de um dos pais ou responsável legal, como exige a LGPD.',
      ]),
      section('10. Encarregado e contato', [
        `Para exercer direitos, tirar dúvidas ou fazer reclamações sobre privacidade, fale conosco ${contact()}. Se não ficar satisfeito, você pode procurar a Autoridade Nacional de Proteção de Dados (ANPD).`,
      ]),
      section('11. Mudanças nesta Política', [
        'Podemos atualizar esta Política. A versão em vigor fica sempre disponível no sistema e, em mudanças importantes, comunicamos por e-mail ou aviso na tela.',
      ]),
    ],
  };
}

export const getDocument = (type) => (type === 'terms' ? terms() : privacy());
