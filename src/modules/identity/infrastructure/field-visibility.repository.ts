import { sql } from 'drizzle-orm';

import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { FieldVisibilityRule } from '../../../shared/authz/masking.js';

/** Field-visibility rule reads (T-029, D-025). */

export class FieldVisibilityRepository {
  /**
   * The effective rules for the bound tenant.
   *
   * Precedence is resolved in SQL: `DISTINCT ON (table_name, field_name)` with
   * `company_id NULLS LAST` takes the company's own rule when it has one and
   * the platform default otherwise. Doing it in the application would mean
   * merging two lists, and a merge is where the precedence quietly inverts.
   *
   * RLS already restricts the rows to this tenant's plus the platform
   * defaults — migration 013's split read policy on this table is what makes
   * `company_id IS NULL` visible at all.
   */
  async rulesFor(tx: TxScope): Promise<FieldVisibilityRule[]> {
    const result = await unwrapTxScope(tx).execute<FieldVisibilityRule>(sql`
      select distinct on (fvr.table_name, fvr.field_name)
             fvr.table_name as "tableName",
             fvr.field_name as "fieldName",
             p.key          as "requiredPermission"
        from field_visibility_rules fvr
        join permissions p on p.id = fvr.required_permission_id
       order by fvr.table_name, fvr.field_name, fvr.company_id nulls last
    `);
    return result.rows;
  }
}
