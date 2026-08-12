// RULE 4 (ER-025): row spread into a response
declare const row: Record<string, unknown>;
export function toResponse(): Record<string, unknown> {
  return { ...row, id: 'x' };
}
