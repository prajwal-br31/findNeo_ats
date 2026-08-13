import { randomUUID } from 'node:crypto';

import type { MailMessage, MailPort, SentMail } from '../../shared/ports/mail.js';

/**
 * In-memory `MailPort` (11 §7).
 *
 * 11 §7 is explicit about what a test may assert on: **recipients and template
 * ids, never body text containing personal data**. The messages are retained
 * in full so a test *can* check a recipient, but `assertSent` is the intended
 * door and it deliberately matches on template id.
 */
export class FakeMail implements MailPort {
  readonly #sent: MailMessage[] = [];

  send(message: MailMessage): Promise<SentMail> {
    this.#sent.push(message);
    return Promise.resolve({ messageId: randomUUID(), templateId: message.templateId });
  }

  sent(): readonly MailMessage[] {
    return [...this.#sent];
  }

  sentTo(recipient: string): readonly MailMessage[] {
    return this.#sent.filter((message) => message.to === recipient);
  }

  templateIds(): readonly string[] {
    return this.#sent.map((message) => message.templateId);
  }

  reset(): void {
    this.#sent.length = 0;
  }
}
