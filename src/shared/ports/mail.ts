/**
 * `MailPort` (D-004).
 *
 * SMTP on-premise, a provider API for the hosted product. Phase 0 ships the
 * `log` driver.
 *
 * **A rendered message is full of personal data** — candidate names, email
 * addresses, salary figures. None of it may reach a log, a trace, or an error
 * report (ER-048, SEC-033). That constrains the port itself: a message is
 * described by a template id and variables, and an implementation that wants
 * to be observable logs the template id and the message id, never the address
 * or the rendered body.
 */

export interface MailMessage {
  /** Personal data. Never logged. */
  readonly to: string;
  readonly templateId: string;
  /** May contain personal data. Never logged. */
  readonly variables: Readonly<Record<string, string>>;
}

export interface SentMail {
  readonly messageId: string;
  readonly templateId: string;
}

export interface MailPort {
  send(message: MailMessage): Promise<SentMail>;
}
