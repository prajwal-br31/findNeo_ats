// D-044: platform/db's client is behind an entry-point restriction
import { databaseClient } from '../../../platform/db/client.js';
export const bad = databaseClient;
