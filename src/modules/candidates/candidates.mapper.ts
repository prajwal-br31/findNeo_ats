import type { FieldVisibility } from '../../shared/authz/masking.js';
import type { ResolvedPermissions } from '../../shared/authz/permission-cache.js';

/**
 * Candidate and application serialization with compensation masking
 * (T-070, BR-091, 07 §8).
 *
 * **Allowlist mappers** (ER-025): every field is named. Spreading a row would
 * ship whatever column is added next, and on these two tables the columns
 * most likely to be added next are exactly the sensitive ones.
 *
 * Masking runs against the `field_visibility_rules` the identity module
 * resolves, so which permission earns which field lives in the database and
 * not in this file. What lives here is the camelCase → column-name mapping,
 * written out explicitly: a generic snake_case conversion that got one name
 * wrong would fail open, silently, forever.
 */

export interface CandidateRecord {
  readonly id: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly currentTitle: string | null;
  readonly currentEmployer: string | null;
  readonly totalExperienceYears: string | null;
  readonly currentCtc: string | null;
  readonly ctcCurrency: string | null;
  readonly educationLevel: string | null;
  readonly locationCity: string | null;
  readonly locationCountry: string | null;
  readonly linkedinUrl: string | null;
  readonly source: string;
  readonly currentResumeId: string | null;
  readonly consentStatus: string;
  readonly createdAt: Date | string;
}

export interface CandidateView extends Record<string, unknown> {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  currentTitle: string | null;
  currentEmployer: string | null;
  totalExperienceYears: number | null;
  currentCtc: number | null;
  ctcCurrency: string | null;
  educationLevel: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  linkedinUrl: string | null;
  source: string;
  currentResumeId: string | null;
  consentStatus: string;
  createdAt: string;
}

/** view field → the column name `field_visibility_rules` keys on. */
const CANDIDATE_COLUMNS: Readonly<Record<string, string>> = {
  currentCtc: 'current_ctc',
  email: 'email',
  phone: 'phone',
};

function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Nulls every field the caller has not earned and names them in `_masked`
 * (07 §8) — never omitted, never sent with a "hide me" flag.
 *
 * `_masked` is absent entirely when nothing was withheld, so a client can
 * treat its presence as meaningful.
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

function toCandidateView(row: CandidateRecord): CandidateView {
  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    currentTitle: row.currentTitle,
    currentEmployer: row.currentEmployer,
    /* numeric arrives as a string from pg — JS numbers cannot represent every
       value of the type, so the driver refuses to guess. Converted here
       because the wire format is JSON. */
    totalExperienceYears: toNumber(row.totalExperienceYears),
    currentCtc: toNumber(row.currentCtc),
    ctcCurrency: row.ctcCurrency,
    educationLevel: row.educationLevel,
    locationCity: row.locationCity,
    locationCountry: row.locationCountry,
    linkedinUrl: row.linkedinUrl,
    source: row.source,
    currentResumeId: row.currentResumeId,
    consentStatus: row.consentStatus,
    createdAt: toIso(row.createdAt),
  };
}

export function toCandidate(
  row: CandidateRecord,
  visibility: FieldVisibility,
  permissions: ResolvedPermissions,
): CandidateView {
  return applyMasking(
    toCandidateView(row),
    'candidates',
    CANDIDATE_COLUMNS,
    visibility,
    permissions,
  );
}

/**
 * Exists so a list endpoint cannot forget to mask. A single-resource mapper
 * that collections bypass is the standard way compensation leaks.
 */
export function toCandidates(
  rows: readonly CandidateRecord[],
  visibility: FieldVisibility,
  permissions: ResolvedPermissions,
): CandidateView[] {
  return rows.map((row) => toCandidate(row, visibility, permissions));
}
