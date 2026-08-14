/**
 * Message bodies, rendered from a template id and variables.
 *
 * The port passes ids and variables rather than a rendered body precisely so
 * that nothing above `platform/` handles the text (ER-048) — rendering has to
 * happen somewhere, and this is the somewhere.
 *
 * Plain text only. HTML mail needs sanitisation of every interpolated value,
 * and an unescaped candidate name in an invitation is a stored-XSS delivery
 * mechanism aimed at whoever opens it.
 */

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
}

type Renderer = (vars: Readonly<Record<string, string>>) => RenderedMail;

const TEMPLATES: Readonly<Record<string, Renderer>> = {
  'email.verification': (vars) => ({
    subject: 'Verify your FindNeo email address',
    text:
      `Welcome to FindNeo.\n\n` +
      `Confirm your email address to finish setting up your account:\n` +
      `${vars['verifyUrl'] ?? ''}\n\n` +
      `If you did not sign up, ignore this message.\n`,
  }),

  'invitation.created': (vars) => ({
    subject: `You have been invited to join ${vars['companyName'] ?? 'a team'} on FindNeo`,
    text:
      `${vars['companyName'] ?? 'A team'} has invited you to join them on FindNeo.\n\n` +
      `Accept the invitation:\n${vars['acceptUrl'] ?? ''}\n\n` +
      `This invitation expires on ${vars['expiresAt'] ?? 'the stated date'}.\n`,
  }),
};

export class UnknownTemplateError extends Error {
  constructor(templateId: string) {
    super(`no mail template registered for "${templateId}"`);
    this.name = 'UnknownTemplateError';
  }
}

/**
 * Throws on an unknown id rather than sending a blank message. A silently
 * empty email is indistinguishable from a delivery problem and gets debugged
 * against the mail server for an afternoon.
 */
export function renderTemplate(
  templateId: string,
  variables: Readonly<Record<string, string>>,
): RenderedMail {
  const renderer = TEMPLATES[templateId];
  if (renderer === undefined) throw new UnknownTemplateError(templateId);
  return renderer(variables);
}
