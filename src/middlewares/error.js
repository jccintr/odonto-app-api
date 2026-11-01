import { HttpError } from '../utils/errors.js';

export const notFoundHandler = (req, res) => res.status(404).json({ error: 'Rota não encontrada.' });

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  if (err instanceof HttpError) {
    if (err.status === 429 && err.extra.retryAfterSeconds) res.set('Retry-After', String(err.extra.retryAfterSeconds));
    return res.status(err.status).json({ error: err.message, ...err.extra });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Requisição grande demais.' });
  if (err?.code === '23505') return res.status(409).json({ error: 'Registro duplicado.' });
  if (err?.code === '23503') return res.status(409).json({ error: 'Registro em uso ou referência inválida.' });
  if (err?.code === '22P02') return res.status(400).json({ error: 'Identificador inválido.' });

  console.error('Erro não tratado:', err);
  return res.status(500).json({ error: 'Erro interno do servidor.' });
};
