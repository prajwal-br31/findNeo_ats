// ER-003b: the domain layer imports nothing, including platform code
import { databaseClient } from '../../../platform/db/client.js';
export const bad = databaseClient;
