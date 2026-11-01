// Agendador dos lembretes de consulta, dentro da própria API (REMINDERS_SCHEDULER=true). Com vários servidores no ar,
// todos rodam, mas o runReminders trava de verdade e só um trabalha por vez.
import { config } from '../config/env.js';
import { runReminders } from '../modules/notifications/notifications.reminders.js';

/** Liga o agendador e devolve a função que desliga. Erro num ciclo nunca derruba a API. */
export function startReminderScheduler({ run = runReminders, intervalMinutes = config.remindersIntervalMinutes } = {}) {
  const tick = async () => {
    try {
      const summary = await run();
      if (summary.sent || summary.failed) console.log(`Lembretes: ${summary.sent} enviados, ${summary.failed} com falha.`);
    } catch (err) {
      console.error('Lembretes: falha no ciclo —', err.message);
    }
  };
  const timer = setInterval(tick, intervalMinutes * 60_000);
  timer.unref();
  setImmediate(tick);
  return () => clearInterval(timer);
}
