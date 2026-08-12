// ER-002a: the BFF may never touch platform/db
import { databaseClient } from '../../platform/db/client.js';
export const bad = databaseClient;
