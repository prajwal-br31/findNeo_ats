// RULE 3 form 4 (ER-011): dynamic import escapes a static-import-only rule
export async function bad(): Promise<unknown> {
  const mailer = await import('nodemailer');
  return mailer;
}
