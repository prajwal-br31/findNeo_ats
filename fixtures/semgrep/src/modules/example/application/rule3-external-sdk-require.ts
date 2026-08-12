// RULE 3 form 3 (ER-011): CommonJS acquisition
const boss: unknown = require('pg-boss');
export const bad = boss;
