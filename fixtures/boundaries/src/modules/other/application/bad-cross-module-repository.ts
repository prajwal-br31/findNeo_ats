// ER-007: cross-module access is service to service, never repository to repository
import { findExample } from '../../example/infrastructure/example.repository.js';
export const bad = findExample;
