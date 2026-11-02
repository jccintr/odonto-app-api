// Modelos de clínica oferecidos no cadastro. Os preços são EXEMPLOS de mercado (consultório particular, 2026): a clínica
// precisa revisar a tabela antes de usar (o painel lembra disso até ela confirmar). Valores em centavos.
const p = (name, category, priceCents, odontogramCondition = null, costCents = 0) => ({ name, category, priceCents, costCents, odontogramCondition });

export const TEMPLATES = [
  {
    code: 'general',
    name: 'Clínica geral',
    description: 'Consulta, limpeza, restaurações, canal, extração, clareamento e prótese, com preços de exemplo.',
    procedures: [
      p('Consulta de avaliação', 'Diagnóstico', 12000),
      p('Radiografia periapical', 'Diagnóstico', 4000),
      p('Limpeza (profilaxia)', 'Prevenção', 18000),
      p('Aplicação de flúor', 'Prevenção', 8000),
      p('Selante (por dente)', 'Prevenção', 9000, 'sealant'),
      p('Restauração em resina — 1 face', 'Dentística', 20000, 'restoration'),
      p('Restauração em resina — 2 faces', 'Dentística', 28000, 'restoration'),
      p('Restauração em resina — 3 ou mais faces', 'Dentística', 36000, 'restoration'),
      p('Tratamento de canal — dente anterior', 'Endodontia', 80000, 'root_canal'),
      p('Tratamento de canal — molar', 'Endodontia', 130000, 'root_canal'),
      p('Extração simples', 'Cirurgia', 18000, 'extracted'),
      p('Extração de siso', 'Cirurgia', 45000, 'extracted'),
      p('Raspagem periodontal (por sextante)', 'Periodontia', 22000),
      p('Clareamento de consultório', 'Estética', 90000),
      p('Coroa em porcelana', 'Prótese', 150000, 'crown', 40000),
    ],
  },
  {
    code: 'orthodontics',
    name: 'Ortodontia',
    description: 'Documentação, aparelhos fixos e estéticos, manutenção mensal, contenção e remoção, com preços de exemplo.',
    procedures: [
      p('Consulta ortodôntica', 'Ortodontia', 15000),
      p('Documentação ortodôntica', 'Ortodontia', 35000),
      p('Radiografia panorâmica', 'Diagnóstico', 12000),
      p('Telerradiografia com traçado cefalométrico', 'Diagnóstico', 12000),
      p('Instalação de aparelho fixo metálico', 'Ortodontia', 120000),
      p('Manutenção mensal — aparelho metálico', 'Ortodontia', 20000),
      p('Instalação de aparelho estético', 'Ortodontia', 220000),
      p('Manutenção mensal — aparelho estético', 'Ortodontia', 25000),
      p('Colagem de bráquete avulso', 'Ortodontia', 5000),
      p('Remoção do aparelho', 'Ortodontia', 15000),
      p('Contenção (por arcada)', 'Ortodontia', 25000),
      p('Limpeza (profilaxia)', 'Prevenção', 18000),
    ],
  },
  {
    code: 'empty',
    name: 'Clínica vazia',
    description: 'Começa sem nenhum procedimento: você cadastra tudo do seu jeito.',
    procedures: [],
  },
];

export const TEMPLATE_CODES = TEMPLATES.map((t) => t.code);
export const findTemplate = (code) => TEMPLATES.find((t) => t.code === code);
