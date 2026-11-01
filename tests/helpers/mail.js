import { sendPasswordResetEmail, sendVerificationEmail } from '../../src/services/mailer.js';

// Extrai o token do último e-mail "enviado" (o mailer é um espião nos testes).
const tokenFrom = (mock) => new URL(mock.mock.calls.at(-1)[0].url).searchParams.get('token');
export const lastVerificationToken = () => tokenFrom(sendVerificationEmail);
export const lastResetToken = () => tokenFrom(sendPasswordResetEmail);
