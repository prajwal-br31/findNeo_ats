import type { FieldVisibility } from '../../shared/authz/masking.js';
import type { ResolvedPermissions } from '../../shared/authz/permission-cache.js';

/**
 * Application serialization with compensation masking (T-070).
 *
 * The snapshot columns keep their `snapshot` prefix all the way to the wire.
 * That is deliberate: a client reading `snapshotCurrentCtc` cannot mistake it
 * for the candidate's current figure, and the two genuinely differ once a
 * profile is edited (BR-055).
 */

/*
 * Duplicated from `candidates.mapper.ts` rather than shared.
 *
 * Two module-support files may not import each other (ER-001), and the rule
 * is right here: a shared masking helper is exactly the thing that gets
 * "improved" for one caller and silently changes the other. Twenty lines
 * repeated is cheaper than one mapper quietly unmasking the other's fields.
 */
function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Nulls every field the caller has not earned and names them in `_masked`
 * (07 §8) — never omitted, never a value with a "hide me" flag. `_masked` is
 * absent entirely when nothing was withheld.
 */
function applyMasking<T extends Record<string, unknown>>(
  view: T,
  tableName: string,
  columns: Readonly<Record<string, string>>,
  visibility: FieldVisibility,
  permissions: ResolvedPermissions,
): T {
  const withheld: string[] = [];
  const masked: Record<string, unknown> = { ...view };

  for (const [field, column] of Object.entries(columns)) {
    const required = visibility.requiredFor(tableName, column);
    if (required === undefined || permissions.keys.has(required)) continue;
    masked[field] = null;
    withheld.push(field);
  }

  if (withheld.length > 0) masked['_masked'] = withheld;
  return masked as T;
}

export interface ApplicationRecord {
  readonly id: string;
  readonly jobId: string;
  readonly jobTitle: string | null;
  readonly candidateId: string;
  readonly currentStageId: string | null;
  readonly currentStageName: string | null;
  readonly status: string;
  readonly source: string;
  readonly ownerUserId: string | null;
  readonly formTemplateVersionId: string;
  readonly customFields: unknown;
  readonly appliedAt: Date | string;
  readonly closedAt: Date | string | null;
  readonly transferredFromId: string | null;
  readonly snapshotFullName: string;
  readonly snapshotEmail: string | null;
  readonly snapshotPhone: string | null;
  readonly snapshotCurrentTitle: string | null;
  readonly snapshotCurrentEmployer: string | null;
  readonly snapshotExperienceYears: string | null;
  readonly snapshotCurrentCtc: string | null;
  readonly snapshotExpectedCtc: string | null;
  readonly snapshotNoticePeriodDays: number | null;
  readonly snapshotCtcCurrency: string | null;
  readonly snapshotLocation: string | null;
  readonly snapshotEducationLevel: string | null;
}

export interface ApplicationView extends Record<string, unknown> {
  id: string;
  jobId: string;
  jobTitle: string | null;
  candidateId: string;
  currentStageId: string | null;
  currentStageName: string | null;
  status: string;
  source: string;
  ownerUserId: string | null;
  formTemplateVersionId: string;
  customFields: unknown;
  appliedAt: string;
  closedAt: string | null;
  transferredFromId: string | null;
  snapshotFullName: string;
  snapshotEmail: string | null;
  snapshotPhone: string | null;
  snapshotCurrentTitle: string | null;
  snapshotCurrentEmployer: string | null;
  snapshotExperienceYears: number | null;
  snapshotCurrentCtc: number | null;
  snapshotExpectedCtc: number | null;
  snapshotNoticePeriodDays: number | null;
  snapshotCtcCurrency: string | null;
  snapshotLocation: string | null;
  snapshotEducationLevel: string | null;
}

/**
 * view field → column. Every masked column on `applications` appears here; a
 * sensitive column added to the table and not to this map is unmasked on the
 * wire, which is why the seed migration and this object were written together.
 */
const APPLICATION_COLUMNS: Readonly<Record<string, string>> = {
  snapshotCurrentCtc: 'snapshot_current_ctc',
  snapshotExpectedCtc: 'snapshot_expected_ctc',
  snapshotNoticePeriodDays: 'snapshot_notice_period_days',
  snapshotEmail: 'snapshot_email',
  snapshotPhone: 'snapshot_phone',
};

function toView(row: ApplicationRecord): ApplicationView {
  return {
    id: row.id,
    jobId: row.jobId,
    jobTitle: row.jobTitle,
    candidateId: row.candidateId,
    currentStageId: row.currentStageId,
    currentStageName: row.currentStageName,
    status: row.status,
    source: row.source,
    ownerUserId: row.ownerUserId,
    formTemplateVersionId: row.formTemplateVersionId,
    customFields: row.customFields,
    appliedAt: toIso(row.appliedAt),
    closedAt: row.closedAt === null ? null : toIso(row.closedAt),
    transferredFromId: row.transferredFromId,
    snapshotFullName: row.snapshotFullName,
    snapshotEmail: row.snapshotEmail,
    snapshotPhone: row.snapshotPhone,
    snapshotCurrentTitle: row.snapshotCurrentTitle,
    snapshotCurrentEmployer: row.snapshotCurrentEmployer,
    snapshotExperienceYears: toNumber(row.snapshotExperienceYears),
    snapshotCurrentCtc: toNumber(row.snapshotCurrentCtc),
    snapshotExpectedCtc: toNumber(row.snapshotExpectedCtc),
    snapshotNoticePeriodDays: row.snapshotNoticePeriodDays,
    snapshotCtcCurrency: row.snapshotCtcCurrency,
    snapshotLocation: row.snapshotLocation,
    snapshotEducationLevel: row.snapshotEducationLevel,
  };
}

export function toApplication(
  row: ApplicationRecord,
  visibility: FieldVisibility,
  permissions: ResolvedPermissions,
): ApplicationView {
  return applyMasking(toView(row), 'applications', APPLICATION_COLUMNS, visibility, permissions);
}

export function toApplications(
  rows: readonly ApplicationRecord[],
  visibility: FieldVisibility,
  permissions: ResolvedPermissions,
): ApplicationView[] {
  return rows.map((row) => toApplication(row, visibility, permissions));
}
