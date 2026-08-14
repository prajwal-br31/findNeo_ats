/**
 * The inputs a row-scope predicate needs (T-045, 04 §4).
 *
 * Lives in `shared/authz` rather than in the jobs module because both sides of
 * the boundary need it: the controller assembles one from the request, and the
 * repository turns it into SQL. A controller may not import `infrastructure`
 * (ER-002), so a type declared there would force the scope to be rebuilt in
 * the service from loose arguments — which is how the department list and the
 * permission set end up out of step.
 *
 * Every field is resolved **once per request** by the authorization pipeline.
 * Re-reading them per query costs a round trip and risks the two disagreeing
 * mid-request.
 */
export interface RowScopeContext {
  readonly userId: string;
  readonly departmentIds: readonly string[];
  readonly permissions: ReadonlySet<string>;
}
