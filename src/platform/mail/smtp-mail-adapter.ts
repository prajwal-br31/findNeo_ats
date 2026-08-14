import { createTransport, type Transporter } from 'nodemailer';

import type { MailMessage, MailPort, SentMail } from '../../shared/ports/mail.js';

import { renderTemplate } from './templates.js';

/**
 * The `smtp` driver (D-004, 05a §5).
 *
 * **Nothing here logs a recipient or the password.** An address is personal
 * data (ER-048) and the password is a secret (SEC-060); both are easy to leak
 * through an error object, so failures are re-thrown as a message carrying the
 * template id and the host, and nothing else. nodemailer's own errors can
 * contain the envelope, which is why they are never propagated verbatim.
 */

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly from: string;
}

export class SmtpMailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpMailError';
  }
}

export class SmtpMailAdapter implements MailPort {
  readonly #transport: Transporter;
  readonly #from: string;
  readonly #host: string;

  constructor(settings: SmtpSettings) {
    this.#from = settings.from;
    this.#host = settings.host;
    this.#transport = createTransport({
      host: settings.host,
      port: settings.port,
      /* Implicit TLS on 465, STARTTLS everywhere else. Derived from the port
         rather than exposed as a fourth knob nobody sets correctly. */
      secure: settings.port === 465,
      auth: { user: settings.user, pass: settings.password },
    });
  }

  /**
   * Proves the credentials work, at boot.
   *
   * Without this a wrong password surfaces at the first send — which is inside
   * a worker, on a job that will retry and dead-letter, hours after the deploy
   * that broke it. `verify()` opens a connection and authenticates, so the
   * process fails to start instead.
   */
  async verify(): Promise<void> {
    try {
      await this.#transport.verify();
    } catch (error) {
      /* The reason is included — "Invalid login" is what the operator needs —
         but never the password, and nodemailer does not put it in `message`.
         The error object itself is not attached, because its `command` and
         response fields can echo the envelope. */
      const reason = error instanceof Error ? error.message : 'unknown error';
      throw new SmtpMailError(`SMTP verification against ${this.#host} failed: ${reason}`);
    }
  }

  async send(message: MailMessage): Promise<SentMail> {
    const rendered = renderTemplate(message.templateId, message.variables);

    try {
      /* `sendMail` is typed `any` by @types/nodemailer, so the one field this
         reads is narrowed rather than trusted (ER-013). */
      const info = (await this.#transport.sendMail({
        from: this.#from,
        to: message.to,
        subject: rendered.subject,
        text: rendered.text,
      })) as { messageId?: unknown };

      const messageId = typeof info.messageId === 'string' ? info.messageId : 'unknown';
      return { messageId, templateId: message.templateId };
    } catch (error) {
      /* Deliberately does not include `message.to`. A failed send is exactly
         when someone reaches for the address to debug with, and exactly when
         it must not enter a log (ER-048). */
      const reason = error instanceof Error ? error.message : 'unknown error';
      throw new SmtpMailError(`sending "${message.templateId}" failed: ${reason}`);
    }
  }

  async close(): Promise<void> {
    this.#transport.close();
    return Promise.resolve();
  }
}
