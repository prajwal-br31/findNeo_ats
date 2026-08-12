// GATE: "Linter rejects a BFF file importing a repository" (ER-002a)
import { findExample } from '../../modules/example/infrastructure/example.repository.js';
export const bad = findExample;
