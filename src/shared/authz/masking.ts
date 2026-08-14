import type { ResolvedPermissions } from './permission-cache.js';

/**
 * Field-level masking (T-029, D-025, ER-025).
 *
 * PostgreSQL RLS decides which *rows* you may see; it cannot mask a column.
 * So masking is necessarily an application-layer concern, applied at
 * serialization, **after** row access has already resolved.
 *
 * That ordering matters: masking is not access control. A masked field is one
 * you may not *read*, on a row you were legitimately allowed to fetch. Using
 * it the other way around — masking instead of filtering — would leak row
 * existence through the shape of the response.
 *
 * **A field with no rule is unmasked.** The rules table is an allowlist of
 * things that must be earned, not a denylist of things that are open.
 *
 * **The value is nulled and the field named in `_masked`** (07 §8). Never the
 * value with a flag telling the client to hide it — the API does not send a
 * value the caller may not see. And never a bare null either: `_masked` is
 * what lets a client distinguish "restricted" from "not set" without
 * inferring it from context.
 */

/** `(table, field) -> required permission key`, resolved from the database. */
/**
 * A serialized row after masking: every original key survives, withheld ones
 * carry `null`, and `_masked` names them.
 */
export type MaskedRow<T> = { [K in keyof T]: T[K] | null } & { _masked?: string[] };

export interface FieldVisibilityRule extends Record<string, unknown> {
  readonly tableName: string;
  readonly fieldName: string;
  readonly requiredPermission: string;
}

/**
 * The rules for one company, indexed for lookup.
 *
 * Built once per request rather than per field: a serialization pass over a
 * page of 25 rows with a dozen fields each is 300 lookups, and a linear scan
 * of the rule list for each is the kind of thing that looks free until a
 * tenant writes forty rules.
 */
export class FieldVisibility {
  readonly #byTableField: ReadonlyMap<string, string>;

  constructor(rules: readonly FieldVisibilityRule[]) {
    const index = new Map<string, string>();
    for (const rule of rules) {
      index.set(`${rule.tableName}.${rule.fieldName}`, rule.requiredPermission);
    }
    this.#byTableField = index;
  }

  /** The permission a field requires, or undefined when it is unmasked. */
  requiredFor(tableName: string, fieldName: string): string | undefined {
    return this.#byTableField.get(`${tableName}.${fieldName}`);
  }

  /**
   * Applies masking to one serialized row (07 §8).
   *
   * The field keeps its key, its value becomes `null`, and its name is listed
   * in `_masked`. The client shows a "restricted" affordance from `_masked`
   * rather than inferring one from a null it cannot interpret.
   *
   * `_masked` is omitted entirely when nothing was withheld, so an unrestricted
   * response carries no empty array for every client to special-case.
   */
  apply<T extends Record<string, unknown>>(
    tableName: string,
    row: T,
    permissions: ResolvedPermissions,
  ): MaskedRow<T> {
    const result: Record<string, unknown> = {};
    const withheld: string[] = [];

    for (const [field, value] of Object.entries(row)) {
      const required = this.requiredFor(tableName, field);
      if (required !== undefined && !permissions.keys.has(required)) {
        result[field] = null;
        withheld.push(field);
        continue;
      }
      result[field] = value;
    }

    if (withheld.length > 0) result['_masked'] = withheld;
    return result as MaskedRow<T>;
  }

  /**
   * Collection items are masked identically to single resources (07 §8) —
   * as are expanded sub-resources, exports, webhook payloads and audit
   * entries. A viewer without permission for a field sees that it changed and
   * by whom, with the value masked; otherwise the audit trail becomes a bypass
   * of the control it exists to enforce.
   */
  applyAll<T extends Record<string, unknown>>(
    tableName: string,
    rows: readonly T[],
    permissions: ResolvedPermissions,
  ): MaskedRow<T>[] {
    return rows.map((row) => this.apply(tableName, row, permissions));
  }
}
