// RULE 6 (ER-018): tenant binding that is not transaction-local
declare const client: { query: (s: string) => void };
export function bad(companyId: string): void {
  client.query(`SET app.current_company_id = '${companyId}'`);
  client.query("SELECT set_config('app.current_company_id', $1, false)");
}
