import type { FieldVisibility } from '../../shared/authz/masking.js';
import type { ResolvedPermissions } from '../../shared/authz/permission-cache.js';

/**
 * The row shape this mapper reads, declared structurally rather than imported.
 *
 * A mapper is module-support and may not import `infrastructure` (ER-001) —
 * and that is the right constraint here: naming the fields it consumes is what
 * makes the allowlist an allowlist. Importing the repository's row type would
 * let a column added there flow into the response by inheritance.
 * `JobRecord` satisfies this structurally, so the repository stays the source of
 * truth for the query without the mapper depending on it.
 */
export interface JobRecord {
  readonly id: string;
  readonly title: string;
  readonly departmentId: string;
  readonly description: string | null;
  readonly countryCode: string | null;
  readonly city: string | null;
  readonly headcount: number;
  readonly status: string;
  readonly confidential: boolean;
  readonly employmentType: string | null;
  readonly workMode: string | null;
  readonly salaryMin: string | null;
  readonly salaryMax: string | null;
  readonly salaryCurrency: string | null;
  readonly publishToCareerSite: boolean;
  readonly publishedAt: Date | string | null;
  readonly formTemplateVersionId: string;
  readonly customFields: unknown;
  readonly createdAt: Date | string;
}

/** The list row's extra columns. Absent on the single-job path. */
export interface JobListRecord extends JobRecord {
  readonly departmentName: string | null;
  readonly teamCount: number;
  readonly applicationCount: number;
}

/**
 * Job serialization with salary masking (T-050, BR-091, 08-lld-jobs §6).
 *
 * An **allowlist** mapper (ER-025): every field is named. Spreading the row
 * would ship `custom_fields` internals and any column added later, and the
 * salary columns are exactly the ones that must not escape by accident.
 *
 * Masking runs through the same `FieldVisibility` the identity module built,
 * against table name `jobs` — so the rule that `salary_min` needs
 * `jobs.salary.read` lives in `field_visibility_rules` and not in this file.
 *
 * **It applies in lists and expansions too**, which is why `toJobViews` exists
 * rather than callers mapping the array themselves. A single-resource mapper
 * that lists forget to use is the standard way salary leaks through a
 * collection endpoint.
 */

export interface JobView extends Record<string, unknown> {
  id: string;
  title: string;
  departmentId: string;
  description: string | null;
  countryCode: string | null;
  city: string | null;
  headcount: number;
  status: string;
  confidential: boolean;
  employmentType: string | null;
  workMode: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  publishToCareerSite: boolean;
  publishedAt: string | null;
  formTemplateVersionId: string;
  customFields: unknown;
  createdAt: string;
}

export interface JobListView extends JobView {
  departmentName: string | null;
  teamCount: number;
  applicationCount: number;
}

function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toView(row: JobRecord): JobView {
  return {
    id: row.id,
    title: row.title,
    departmentId: row.departmentId,
    description: row.description,
    countryCode: row.countryCode,
    city: row.city,
    headcount: row.headcount,
    status: row.status,
    confidential: row.confidential,
    employmentType: row.employmentType,
    workMode: row.workMode,
    /* numeric(14,2) arrives as a string from pg — JS numbers cannot represent
       every value of that type, so the driver refuses to guess. Converted here
       because the wire format is JSON and the alternative is a quoted number
       every client has to parse. */
    salaryMin: toNumber(row.salaryMin),
    salaryMax: toNumber(row.salaryMax),
    salaryCurrency: row.salaryCurrency,
    publishToCareerSite: row.publishToCareerSite,
    publishedAt: toIso(row.publishedAt),
    formTemplateVersionId: row.formTemplateVersionId,
    customFields: row.customFields,
    createdAt: toIso(row.createdAt) ?? '',
  };
}

/**
 * The rules table keys on the database column names, so the view's camelCase
 * keys are translated before the lookup. Getting this wrong fails open — the
 * rule simply never matches — which is why the mapping is explicit rather than
 * a generic snake_case conversion applied to every key.
 */
const MASKED_COLUMN_BY_FIELD: Readonly<Record<string, string>> = {
  salaryMin: 'salary_min',
  salaryMax: 'salary_max',
};

function applyMasking(
  view: JobView,
  visibility: FieldVisibility,
  permissions: ResolvedPermissions,
): JobView {
  const withheld: string[] = [];
  const masked: Record<string, unknown> = { ...view };

  for (const [field, column] of Object.entries(MASKED_COLUMN_BY_FIELD)) {
    const required = visibility.requiredFor('jobs', column);
    if (required === undefined || permissions.keys.has(required)) continue;
    /* Nulled with a marker (07 §8), never omitted and never sent-with-a-flag. */
    masked[field] = null;
    withheld.push(field);
  }

  if (withheld.length > 0) masked['_masked'] = withheld;
  return masked as JobView;
}

export function toJobView(
  row: JobRecord,
  visibility: FieldVisibility,
  permissions: ResolvedPermissions,
): JobView {
  return applyMasking(toView(row), visibility, permissions);
}

export function toJobViews(
  rows: readonly JobRecord[],
  visibility: FieldVisibility,
  permissions: ResolvedPermissions,
): JobView[] {
  return rows.map((row) => toJobView(row, visibility, permissions));
}

/**
 * The list mapper. Masking runs first, then the three additive fields are
 * added — in that order, so a future rule on one of them cannot be defeated by
 * being written after the mask was applied.
 */
export function toJobListViews(
  rows: readonly JobListRecord[],
  visibility: FieldVisibility,
  permissions: ResolvedPermissions,
): JobListView[] {
  return rows.map((row) => ({
    ...toJobView(row, visibility, permissions),
    departmentName: row.departmentName,
    teamCount: row.teamCount,
    applicationCount: row.applicationCount,
  }));
}
