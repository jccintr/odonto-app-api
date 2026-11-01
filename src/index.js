// Ponto de entrada (npm start). A lógica está em main.js, que é testado.
import 'dotenv/config';
import { start } from './main.js';

try {
  const { stop } = await start();
  const shutdown = () => stop().then(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  console.error('Falha ao iniciar a aplicação:', error);
  process.exit(1);
}
