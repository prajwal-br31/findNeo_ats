// GATE: "a domain file importing Drizzle" (ER-003b)
import { sql } from 'drizzle-orm';
export const bad = sql;
