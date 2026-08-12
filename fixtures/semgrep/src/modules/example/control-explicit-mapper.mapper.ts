// Legal: allowlist serialization, every field named
declare const row: { id: string; title: string; secretHash: string };
export function toResponse(): { id: string; title: string } {
  return { id: row.id, title: row.title };
}
