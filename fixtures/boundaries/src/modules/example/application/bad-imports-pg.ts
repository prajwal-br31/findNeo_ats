// ER-011: `pg` is installed, so this proves external classification works for
// resolvable packages too, not only for absent ones.
import { Client } from 'pg';
export const bad = Client;
