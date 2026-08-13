// Legal: ER-008 puts Drizzle queries in infrastructure/. A repository importing
// drizzle-orm must NOT trip rule 3 — that placement is the boundaries linter's
// job, and it is element-aware in a way a path glob cannot be.
import { eq, sql } from 'drizzle-orm';
export const ok = [eq, sql];
