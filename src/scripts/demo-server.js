// Sobe a API com um PostgreSQL EMBUTIDO (nada para instalar) e dados de demonstração. Serve para:
//  - experimentar o app web sem configurar banco:   npm run demo      (na pasta api)  e   npm run dev   (na pasta web)
//  - os testes de ponta a ponta do app web (web/tests/e2e), que sobem este servidor e imprimem a porta.
// Os dados ficam numa pasta temporária e somem quando o processo termina (Ctrl+C).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });

const quiet = process.argv.includes('--json'); // modo máquina: só uma linha JSON com a URL
const say = (...args) => { if (!quiet) console.log(...args); };

const { default: EmbeddedPostgres } = await import('embedded-postgres');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odonto-demo-pg-'));
const pgPort = await freePort();
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: pgPort, persistent: true, onLog: () => {}, onError: () => {} });
say('Iniciando o PostgreSQL embutido…');
await pg.initialise();
await pg.start();
await pg.createDatabase('odonto_demo');

const apiPort = Number(process.env.PORT) || (quiet ? await freePort() : 3000);
Object.assign(process.env, {
  DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${pgPort}/odonto_demo`,
  PORT: String(apiPort),
  JWT_SECRET: process.env.JWT_SECRET || 'segredo-de-demonstracao',
  JWT_SECRET_PLATFORM: process.env.JWT_SECRET_PLATFORM || 'segredo-da-plataforma-de-demonstracao',
  SMTP_HOST: '', SMTP_USER: '', SMTP_PASSWORD: '',
  BCRYPT_ROUNDS: '4',
  // chave Pix de demonstração (a fatura mostra o QR Code e o "copia e cola"); no seu sistema de verdade use BILLING_PIX_KEY no .env
  BILLING_PIX_KEY: process.env.BILLING_PIX_KEY || '11144477735',
  BILLING_PIX_BENEFICIARY: process.env.BILLING_PIX_BENEFICIARY || 'OdontoApp Demonstracao',
});

const { default: db } = await import('../db/knex.js');
const { hashPassword } = await import('../services/password.js');
const { start } = await import('../main.js');
if (quiet) { console.log = () => {}; console.warn = () => {}; }

await db.migrate.latest();

export const DEMO = {
  clinic: 'Clínica Sorriso',
  admin: { email: 'admin@sorriso.test', password: 'senha-do-admin-123', name: 'Dra. Ana Prado' },
  platform: { email: 'plataforma@sorriso.test', password: 'senha-da-plataforma-1', name: 'Dono da Plataforma' }, // só para o app backoffice
  secretary: { email: 'secretaria@sorriso.test', password: 'senha-da-secretaria-1', name: 'Maria Souza' },
  dentists: [
    { email: 'paulo@sorriso.test', password: 'senha-do-paulo-12345', name: 'Dr. Paulo Lima', color: '#0f766e', cro: 'CRO-MG 12345', specialty: 'Clínico geral', payout: 40 },
    { email: 'bia@sorriso.test', password: 'senha-da-bia-1234567', name: 'Dra. Bia Costa', color: '#7c3aed', cro: 'CRO-MG 23456', specialty: 'Ortodontia', payout: 35 },
  ],
};

await db('platform_admins').insert({ name: DEMO.platform.name, email: DEMO.platform.email, password_hash: await hashPassword(DEMO.platform.password) });
const [clinic] = await db('clinics').insert({ name: DEMO.clinic, slug: 'sorriso' }).returning('*');
const user = async (u, role) => {
  const [row] = await db('users').insert({ clinic_id: clinic.id, name: u.name, email: u.email, role, email_verified_at: new Date(), password_hash: await hashPassword(u.password) }).returning('*');
  return row;
};
await user(DEMO.admin, 'admin');
await user(DEMO.secretary, 'secretary');
for (const d of DEMO.dentists) {
  const row = await user(d, 'dentist');
  await db('dentists').where({ user_id: row.id }).update({ color: d.color, cro: d.cro, specialty: d.specialty, payout_percent: d.payout });
}
const procedures = [
  ['Consulta e avaliação', 'Diagnóstico', 8000, 0, null], ['Limpeza (profilaxia)', 'Prevenção', 15000, 0, null],
  ['Restauração em resina', 'Dentística', 20000, 5000, 'restoration'], ['Tratamento de canal', 'Endodontia', 60000, 12000, 'root_canal'],
  ['Extração simples', 'Cirurgia', 25000, 0, 'extracted'], ['Clareamento', 'Estética', 80000, 15000, null],
];
for (const [name, category, price, cost, condition] of procedures) {
  await db('procedures').insert({ clinic_id: clinic.id, name, category, price_cents: price, cost_cents: cost, odontogram_condition: condition });
}
const patients = [
  { name: 'Ana Lima', cpf: '52998224725', phone: '35999990001', email: 'ana.lima@exemplo.test', birth_date: '1990-05-17', contact_consent: true },
  { name: 'Carlos Souza', cpf: '11144477735', phone: '35999990002', email: 'carlos@exemplo.test', birth_date: '1984-11-02', contact_consent: true },
  { name: 'Marta Ferreira', phone: '35999990003', birth_date: '1972-03-28', contact_consent: false },
];
for (const p of patients) await db('patients').insert({ clinic_id: clinic.id, ...p });

const { server, stop } = await start();
const url = `http://127.0.0.1:${server.address().port}`;
if (quiet) {
  process.stdout.write(`${JSON.stringify({ url, demo: DEMO })}\n`);
} else {
  console.log(`\nAPI de demonstração no ar: ${url}   (documentação em ${url}/docs)\n`);
  console.log(`Clínica: ${DEMO.clinic}`);
  const logins = [
    ['Administradora', DEMO.admin], ['Secretária', DEMO.secretary],
    ...DEMO.dentists.map((d) => [`Dentista (${d.name}${d.specialty ? `, ${d.specialty}` : ''})`, d]),
    ['Backoffice (plataforma)', DEMO.platform],
  ];
  for (const [label, u] of logins) console.log(`  ${label}: ${u.email}  /  ${u.password}`);
  console.log('\nPainel web (pasta web): npm run dev  →  http://localhost:5173  (administração e secretária)');
  console.log('App do dentista (pasta mobile): entre com um dos dentistas acima.');
  console.log('Backoffice (pasta backoffice): npm run dev  →  http://localhost:5174');
  console.log('Ctrl+C para encerrar (os dados de demonstração somem).\n');
}

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await stop().catch(() => {});
  await pg.stop().catch(() => {});
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* limpeza de pasta temporária é só um favor */ }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
