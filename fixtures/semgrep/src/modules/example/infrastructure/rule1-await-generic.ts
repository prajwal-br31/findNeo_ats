// RULE 1 regression (ER-031): an awaited call carrying an explicit type
// argument. The structural pattern misses this combination; the regex arm
// catches it. This is the shape almost all real repository code takes.
declare const tx: { execute: <T>(s: string) => Promise<{ rows: T[] }> };
declare const companyId: string;
export async function bad(): Promise<unknown> {
  const result = await tx.execute<{ id: string }>(
    `SELECT * FROM jobs WHERE company_id = '${companyId}'`,
  );
  return result.rows;
}
