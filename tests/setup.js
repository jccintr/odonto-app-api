import { afterAll, beforeEach, inject, vi } from 'vitest';
import { loginThrottle } from '../src/utils/loginThrottle.js';
import { resetRateLimits } from '../src/middlewares/rateLimit.js';

// o banco vem do globalSetup; precisa estar no ambiente antes de qualquer módulo da aplicação carregar
process.env.DATABASE_URL = inject('databaseUrl');
const { default: db } = await import('../src/db/knex.js');

// Trava de segurança: os testes APAGAM todas as tabelas. Só rodam em banco cujo nome termina com "_test".
const [{ current_database: dbName }] = (await db.raw('SELECT current_database()')).rows;
if (!dbName.endsWith('_test')) {
  throw new Error(`Recusando rodar testes no banco "${dbName}". O nome precisa terminar com _test.`);
}

// Nenhum teste envia e-mail de verdade: os envios viram espiões (o mailer real é testado em mailer.test.js).
vi.mock('../src/services/mailer.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));
const mailer = await import('../src/services/mailer.js');

// Nenhum teste fala com o Cloudinary: o armazenamento vira o falso em memória (o real é testado em cloudinary.test.js).
vi.mock('../src/services/cloudinary.js', () => import('./helpers/fakeStorage.js'));
const { fake: storage } = await import('./helpers/fakeStorage.js');

let tables;
beforeEach(async () => {
  tables ??= (await db.raw("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'knex_%'")).rows
    .map((r) => `"${r.tablename}"`).join(', ');
  await db.raw(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  resetRateLimits();
  storage.reset();
  loginThrottle.clear();
  mailer.sendVerificationEmail.mockReset().mockResolvedValue({});
  mailer.sendPasswordResetEmail.mockReset().mockResolvedValue({});
});

afterAll(async () => {
  await db.destroy();
});
