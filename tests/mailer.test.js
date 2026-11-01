import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock('nodemailer', () => ({ default: { createTransport } }));

// o setup troca o mailer por espiões e já carregou o módulo uma vez (com o nodemailer de verdade);
// aqui queremos o módulo real recarregado com o nodemailer falso
vi.resetModules();
const mailer = await vi.importActual('../src/services/mailer.js');

const configure = (extra = {}) => {
  vi.stubEnv('SMTP_HOST', 'smtp.hostinger.com');
  vi.stubEnv('SMTP_USER', 'contato@odonto.com.br');
  vi.stubEnv('SMTP_PASSWORD', 'segredo');
  Object.entries(extra).forEach(([k, v]) => vi.stubEnv(k, v));
};

beforeEach(() => {
  vi.unstubAllEnvs();
  mailer.resetTransporter();
  sendMail.mockReset().mockResolvedValue({ messageId: 'abc' });
  createTransport.mockClear();
});

describe('smtpConfigured', () => {
  it('exige host, usuário e senha', () => {
    expect(mailer.smtpConfigured()).toBe(false);
    configure();
    expect(mailer.smtpConfigured()).toBe(true);
    for (const name of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']) {
      vi.stubEnv(name, '');
      expect(mailer.smtpConfigured()).toBe(false);
      configure();
    }
  });
});

describe('sendEmail', () => {
  const mail = { to: 'ana@x.com', subject: 'Assunto', html: '<p>oi</p>', text: 'oi' };

  it('sem SMTP, fora da produção, só imprime o e-mail no console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await mailer.sendEmail(mail)).toEqual({ skipped: true });
    expect(warn.mock.calls[0][0]).toContain('ana@x.com');
    expect(sendMail).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('sem SMTP, em produção, é erro', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(mailer.sendEmail(mail)).rejects.toThrow('SMTP não configurado');
  });

  it('com SMTP, envia usando o remetente da conta e reaproveita a conexão', async () => {
    configure();
    await mailer.sendEmail(mail);
    await mailer.sendEmail(mail);

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith({
      pool: true, host: 'smtp.hostinger.com', port: 465, secure: true, auth: { user: 'contato@odonto.com.br', pass: 'segredo' },
    });
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail.mock.calls[0][0]).toEqual({ ...mail, from: '"OdontoApp" <contato@odonto.com.br>' });
  });

  it('porta 587 usa STARTTLS; nome e remetente podem ser configurados', async () => {
    configure({ SMTP_PORT: '587', SMTP_FROM_NAME: 'Clínica X', SMTP_FROM: 'envio@odonto.com.br' });
    await mailer.sendEmail(mail);
    expect(createTransport.mock.calls[0][0]).toMatchObject({ port: 587, secure: false });
    expect(sendMail.mock.calls[0][0].from).toBe('"Clínica X" <envio@odonto.com.br>');
  });

  it('propaga o erro do SMTP', async () => {
    configure();
    sendMail.mockRejectedValueOnce(new Error('auth falhou'));
    await expect(mailer.sendEmail(mail)).rejects.toThrow('auth falhou');
  });
});

describe('modelos de e-mail', () => {
  it('renderTemplate troca as variáveis e escapa HTML', () => {
    const html = mailer.renderTemplate('email-verification', { NAME: '<b>Ana</b> & "Cia"', URL: 'https://x.com/?a=1&b=2', HOURS: 24 });
    expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt; &amp; &quot;Cia&quot;');
    expect(html).toContain('https://x.com/?a=1&amp;b=2');
    expect(html).toContain('24 horas');
    expect(html).not.toContain('{{');
  });

  it('e-mail de verificação', async () => {
    configure();
    await mailer.sendVerificationEmail({ to: 'ana@x.com', name: 'Ana', url: 'https://app/verificar-email?token=T', hours: 24 });
    const sent = sendMail.mock.calls[0][0];
    expect(sent).toMatchObject({ to: 'ana@x.com', subject: 'Confirme seu e-mail — OdontoApp' });
    expect(sent.html).toContain('https://app/verificar-email?token=T');
    expect(sent.text).toContain('https://app/verificar-email?token=T');
    expect(sent.text).toContain('24 horas');
  });

  it('e-mail de redefinição de senha', async () => {
    configure();
    await mailer.sendPasswordResetEmail({ to: 'ana@x.com', name: 'Ana', url: 'https://app/redefinir-senha?token=T', minutes: 60 });
    const sent = sendMail.mock.calls[0][0];
    expect(sent).toMatchObject({ to: 'ana@x.com', subject: 'Redefinição de senha — OdontoApp' });
    expect(sent.html).toContain('https://app/redefinir-senha?token=T');
    expect(sent.text).toContain('60 minutos');
  });
});
