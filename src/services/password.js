import bcryptjs from 'bcryptjs';
import { config } from '../config/env.js';

export const hashPassword = (password) => bcryptjs.hash(password, config.bcryptRounds);
export const verifyPassword = (password, hash) => bcryptjs.compare(password, hash);

// Hash de mentira para gastar o mesmo tempo quando o e-mail não existe (evita descobrir e-mails pelo tempo de resposta).
export const DUMMY_HASH = bcryptjs.hashSync('senha-que-ninguem-usa', 4);
