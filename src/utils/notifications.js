export const NOTIFICATION_KINDS = ['appointment_reminder', 'budget'];
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed'];
export const NOTIFICATION_TRIGGERS = ['auto', 'manual'];
export const MAX_ATTEMPTS = 3; // o lembrete automático tenta no máximo 3 vezes
export const STALE_PENDING_MINUTES = 15; // "enviando" há mais que isso = o servidor caiu no meio; pode tentar de novo
