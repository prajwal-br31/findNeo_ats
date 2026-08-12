import tseslint from 'typescript-eslint';

import { boundariesConfig } from './eslint.boundaries.js';

/**
 * T-002 / T-006a.
 *
 * Every rule here restates an engineering rule from `spec/09-engineering-rules.md`
 * and cites it. A rule that cannot cite one does not belong in this file — style
 * is Prettier's job, and this config is for the rules that have consequences.
 *
 * The planted-violation tree under `fixtures/` is linted by
 * `eslint.fixtures.config.js` instead; see `pnpm verify:boundaries`.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'fixtures/**', 'var/**'],
  },

  ...tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },

  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      /* ER-013 — `any` is prohibited; `unknown` at boundaries, then narrow. */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', minimumDescriptionLength: 10 },
      ],

      /* ER-014 — explicit return types at module boundaries. An inferred
         return type means a change silently alters a contract. */
      '@typescript-eslint/explicit-module-boundary-types': 'error',

      /* ER-016 — named exports only. */
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message:
            'Named exports only — a default export makes a rename invisible in review (ER-016).',
        },
      ],

      /* ER-017 — adding a union member must break the build, not fall through. */
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      /* ER-009 — not style: a 200-line method cannot be reviewed for security. */
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 40, skipBlankLines: true, skipComments: true }],

      /* ER-010 — barrel files make ER-007 unenforceable. Import the file. */
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/index', '**/index.js'],
              message:
                'No barrel files — a re-exporting index makes cross-module access rules ' +
                'unenforceable (ER-010). Import the specific file.',
            },
          ],
        },
      ],

      /* 12 §1 — structured logging only, never console. */
      'no-console': 'error',

      /* ER-030 / SEC-004 — surfaces the await that a check-then-act race needs. */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'error',
    },
  },

  boundariesConfig({ files: ['src/**/*.ts'] }),

  {
    /* Operational tooling: outside the layered tree by design, and it talks to
       PostgreSQL directly because creating a database is not a repository
       concern. It is excluded from the boundaries element set for that reason. */
    files: ['scripts/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  {
    /* Config files and the resolver: plain JS/CJS, outside every tsconfig. */
    files: ['**/*.js', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false, project: false } },
  },

  {
    /* `.cjs` is CommonJS by definition — eslint-module-utils loads the module
       resolver with `require()`, so the resolver cannot be ESM. */
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
