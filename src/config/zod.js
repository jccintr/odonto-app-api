import { z } from 'zod';

// Mensagens padrão de validação em português (as mensagens específicas continuam nos schemas).
z.config(z.locales.pt());

export { z };
