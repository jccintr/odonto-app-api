import app from './app.js';
import { config } from './config/env.js';
import db from './db/knex.js';
import { startReminderScheduler } from './services/scheduler.js';

/** Confere configuração e banco e sobe o servidor. Devolve { server, stop }. */
export async function start() {
  const jwtSecret = config.jwtSecret; // lança se faltar
  if (jwtSecret === config.platformJwtSecret) {
    console.warn('AVISO: JWT_SECRET igual a JWT_SECRET_PLATFORM — use segredos diferentes.');
  }

  await db.raw('SELECT 1');
  console.log('Conectado ao banco de dados com sucesso!');

  const server = await new Promise((resolve) => {
    const s = app.listen(config.port, () => resolve(s));
  });
  console.log(`Servidor ouvindo a porta ${server.address().port}`);

  const stopScheduler = config.remindersScheduler ? startReminderScheduler() : () => {};

  const stop = () =>
    new Promise((resolve) => {
      stopScheduler();
      server.close(async () => {
        await db.destroy();
        resolve();
      });
    });
  return { server, stop };
}
