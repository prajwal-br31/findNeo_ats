// RULE 2 (ER-006): ORM call in an application service
declare const db: { select: (t: unknown) => unknown; transaction: (f: unknown) => unknown };
declare const jobs: unknown;
export const bad = db.select(jobs);
