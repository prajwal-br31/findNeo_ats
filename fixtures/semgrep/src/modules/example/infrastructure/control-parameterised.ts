// Legal: parameterised query, inside infrastructure/
declare const client: { query: (s: string, p: unknown[]) => void };
export function ok(companyId: string): void {
  client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
  client.query('SELECT * FROM jobs WHERE company_id = $1', [companyId]);
}
