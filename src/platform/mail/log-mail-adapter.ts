import { randomUUID } from 'node:crypto';

import type { MailMessage, MailPort, SentMail } from '../../shared/ports/mail.js';

/**
 * The `log` driver: nothing is sent.
 *
 * **It does not log the recipient.** A "log the email" driver is the obvious
 * implementation and it is a direct ER-048 violation — an address is personal
 * data, and a development log is still a log. Only the template id and the
 * generated message id are emitted.
 *
 * The last messages are retained in memory so a developer can still read a
 * verification link locally, which is what `GET /v1/dev/last-email`
 * (08-lld-identity §7, development only) reads.
 */

const RETAINED = 20;

export class LogMailAdapter implements MailPort {
  readonly #recent: MailMessage[] = [];
  readonly #emit: (line: string) => void;

  constructor(emit: (line: string) => void = () => undefined) {
    this.#emit = emit;
  }

  async send(message: MailMessage): Promise<SentMail> {
    const messageId = randomUUID();
    this.#recent.unshift(message);
    if (this.#recent.length > RETAINED) this.#recent.pop();

    // Ids only. Never `message.to`, never the rendered variables.
    this.#emit(`mail.send templateId=${message.templateId} messageId=${messageId}`);
    return Promise.resolve({ messageId, templateId: message.templateId });
  }

  /** Development only. Never wired into a production route. */
  recent(): readonly MailMessage[] {
    return this.#recent;
  }
}
