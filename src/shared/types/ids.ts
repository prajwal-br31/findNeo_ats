/**
 * Branded entity identifiers (ER-015).
 *
 * Passing a `UserId` where a `CandidateId` belongs is a class of bug that has
 * produced real cross-record data exposure in ATS products. These brands make
 * the compiler reject it. The brand is a compile-time fiction: at runtime every
 * one of these is a plain uuid string.
 *
 * Ids are minted by the database (`uuidv7()`, D-032). `unsafeCompanyId` exists
 * for the one legitimate case — a value that has already been validated as a
 * uuid at the edge, or read back out of a row.
 */

declare const brand: unique symbol;

type Branded<T, B extends string> = T & { readonly [brand]: B };

export type CompanyId = Branded<string, 'CompanyId'>;
export type UserId = Branded<string, 'UserId'>;

/**
 * Assert an already-validated uuid string is a `CompanyId`.
 *
 * Callers must have validated the format first — this performs no check, by
 * design, so it stays usable in hot row-mapping paths. The edge validates
 * (ER-034); this only re-labels.
 */
export function unsafeCompanyId(value: string): CompanyId {
  return value as CompanyId;
}

export function unsafeUserId(value: string): UserId {
  return value as UserId;
}
