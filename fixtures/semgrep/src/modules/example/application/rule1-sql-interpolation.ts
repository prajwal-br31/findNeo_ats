// RULE 1 (ER-031): SQL built by interpolation
declare const client: { query: (s: string) => void };
declare const sql: { raw: (s: string) => unknown };
declare const jobId: string;
export function bad1(): void {
  client.query(`SELECT * FROM jobs WHERE id = '${jobId}'`);
}
export const bad2 = sql.raw(`SELECT * FROM jobs WHERE id = '${jobId}'`);
