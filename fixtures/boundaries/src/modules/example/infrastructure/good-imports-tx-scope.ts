// Legal: a repository unwraps the scope its caller passed in
import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
export const ok = unwrapTxScope;
