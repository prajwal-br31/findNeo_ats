// GATE: "Boundaries linter rejects a controller importing a repository" (ER-006)
import { findExample } from './infrastructure/example.repository.js';
export const bad = findExample;
