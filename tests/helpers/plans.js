// Os mesmos planos que a migration cria (a limpeza entre testes apaga a tabela e o setup os recoloca).
export const DEFAULT_PLANS = [
  { code: 'essencial', name: 'Essencial', description: 'Para o consultório com 1 dentista.', price_cents: 7900, max_dentists: 1, position: 1 },
  { code: 'clinica', name: 'Clínica', description: 'Para clínicas com até 4 dentistas.', price_cents: 14900, max_dentists: 4, position: 2 },
  { code: 'premium', name: 'Premium', description: 'Dentistas ilimitados, para clínicas maiores.', price_cents: 24900, max_dentists: null, position: 3 },
];
