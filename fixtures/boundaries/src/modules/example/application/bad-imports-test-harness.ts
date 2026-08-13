// Production code must never import test infrastructure: a fixture reaching
// into shipping code is how a test-only bypass ends up in production.
import { createTestDatabase } from '../../../testing/harness/test-database.js';
export const bad = createTestDatabase;
