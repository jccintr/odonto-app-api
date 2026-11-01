// Erro de regra de negócio com status HTTP; o handler global transforma em JSON.
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (message, extra) => new HttpError(400, message, extra);
export const unauthorized = (message = 'Não autorizado.', extra) => new HttpError(401, message, extra);
export const forbidden = (message = 'Sem permissão para esta ação.', extra) => new HttpError(403, message, extra);
export const emailNotVerified = () =>
  forbidden('Confirme seu e-mail para acessar. Procure o link na sua caixa de entrada ou peça um novo.', { code: 'EMAIL_NOT_VERIFIED' });
export const notFound = (what = 'Recurso') => new HttpError(404, `${what} não encontrado(a).`);
export const unprocessable = (message, extra) => new HttpError(422, message, extra);
export const conflict = (message, extra) => new HttpError(409, message, extra);
export const tooManyRequests = (message, retryAfterSeconds) =>
  new HttpError(429, message, { code: 'RATE_LIMITED', retryAfterSeconds });
