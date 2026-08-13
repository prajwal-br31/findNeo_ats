import { buildTemplateDatabase } from './test-database.js';

/**
 * Builds the template once per run, before any test file (11 §2).
 *
 * Previously each file rebuilt it in `beforeAll`, which was both wasteful —
 * roughly a second each — and racy: rebuilding drops and recreates a database
 * other files may be cloning from, and PostgreSQL refuses to copy a source
 * that has connections. That produced a suite that passed on its own and
 * failed occasionally in aggregate, which is the worst kind of test failure.
 */
export async function setup(): Promise<void> {
  await buildTemplateDatabase();
}
