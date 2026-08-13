// Legal: a test may reach across every layer — a leak test reads as one tenant
// and asserts against another's rows.
import { findExample } from '../infrastructure/example.repository.js';
import { createTestDatabase } from '../../../testing/harness/test-database.js';
export const ok = [findExample, createTestDatabase];
