// Legal and idiomatic: Drizzle's `sql` tag turns ${…} into a bind parameter.
// This is what every repository looks like; rule 1 must not flag it.
import { sql } from 'drizzle-orm';
declare const tx: { execute: <T>(q: unknown) => Promise<{ rows: T[] }> };
declare const id: string;
export async function ok(): Promise<unknown> {
  return tx.execute(sql`delete from jobs where id = ${id}`);
}
