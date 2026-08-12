import tseslint from 'typescript-eslint';

import { boundariesConfig } from './eslint.boundaries.js';

/**
 * Lints the planted-violation tree only.
 *
 * It applies the *same* `boundariesConfig` objects the real code is linted
 * with — rebased onto `fixtures/boundaries/` through `boundaries/root-path` —
 * so `pnpm verify:boundaries` proves the rules that actually run in CI, not a
 * copy of them that can drift.
 *
 * Type-aware parsing is off here: these files are deliberately wrong about
 * architecture, not about types, and they are outside every tsconfig.
 */
export default tseslint.config(
  { ignores: ['**/node_modules/**'] },
  {
    files: ['fixtures/boundaries/src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
  },
  boundariesConfig({
    rootPath: 'fixtures/boundaries',
    files: ['fixtures/boundaries/src/**/*.ts'],
  }),
);
