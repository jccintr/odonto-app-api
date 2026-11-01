import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config/env.js';
import db from './db/knex.js';
import { errorHandler, notFoundHandler } from './middlewares/error.js';
import { limiters, trustProxySetting } from './middlewares/rateLimit.js';
import router from './routes.js';

const app = express();

app.set('trust proxy', trustProxySetting()); // IP real do cliente atrás do proxy (limite de requisições)
app.disable('x-powered-by');

app.use(helmet());
// CORS antes do limite: o 429 também precisa dos cabeçalhos para o front ler a mensagem.
// CORS_ORIGINS (lista separada por vírgula) restringe as origens; sem ela, qualquer origem (o acesso é por token, não por cookie).
app.use(cors(config.corsOrigins ? { origin: config.corsOrigins } : {}));
app.use(limiters.global);
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => res.json({ name: 'OdontoApp API', status: 'ok' }));
app.get('/health', async (req, res) => {
  try {
    await db.raw('SELECT 1');
    res.json({ status: 'ok', database: 'up' });
  } catch {
    res.status(503).json({ status: 'error', database: 'down' });
  }
});

app.use('/api', router);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
