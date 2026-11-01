// Limite de tentativas de login que falham (em memória, por processo).
// A chave é IP + e-mail: quem erra senhas de longe não consegue trancar a conta de outra pessoa.
export function createLoginThrottle({ maxFailures, windowMs }) {
  const entries = new Map(); // chave -> { failures, lockedUntil, firstAt }

  return {
    /** segundos até poder tentar de novo (0 = liberado) */
    blockedFor(key, now = Date.now()) {
      const entry = entries.get(key);
      if (!entry?.lockedUntil || entry.lockedUntil <= now) return 0;
      return Math.ceil((entry.lockedUntil - now) / 1000);
    },
    fail(key, now = Date.now()) {
      let entry = entries.get(key);
      if (!entry || now - entry.firstAt > windowMs) {
        entry = { failures: 0, lockedUntil: null, firstAt: now };
        entries.set(key, entry);
      }
      entry.failures += 1;
      if (entry.failures >= maxFailures) entry.lockedUntil = now + windowMs;
    },
    reset(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}

export const loginThrottle = createLoginThrottle({ maxFailures: 5, windowMs: 15 * 60 * 1000 });
