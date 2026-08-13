/**
 * T-006a — the layer boundary matrix, enforced mechanically.
 *
 * ER-001 / D-037: `client → BFF → controller → application → domain →
 * infrastructure`, dependencies pointing downward only. Any rule a linter can
 * enforce should be enforced by one, because an AI agent — and a tired human —
 * will otherwise violate it confidently and plausibly (05a §8).
 *
 * This module is the single source of truth for the element definitions and
 * the allow matrix. `eslint.config.js` applies it to `src/`;
 * `eslint.fixtures.config.js` applies the same objects to the planted-violation
 * tree under `fixtures/boundaries/` via `boundaries/root-path`, so the rules
 * proving the gate are literally the rules that run in CI.
 */

import boundaries from 'eslint-plugin-boundaries';

/**
 * Order matters — the first matching pattern wins.
 * `platform-db` precedes `platform`, and `controller` precedes
 * `module-support`, because both are narrower cases of the pattern below them.
 */
const ELEMENTS = [
  { type: 'bootstrap', pattern: 'src/bootstrap', mode: 'folder' },
  { type: 'bff', pattern: 'src/bff/*', mode: 'folder', capture: ['client'] },

  /* The database client is its own element so it can be denied to the BFF,
     to controllers and to the application layer, while `platform/*` as a
     whole stays importable (ER-006). */
  { type: 'platform-db', pattern: 'src/platform/db', mode: 'folder' },
  { type: 'platform', pattern: 'src/platform/*', mode: 'folder', capture: ['adapter'] },

  { type: 'shared', pattern: 'src/shared/*', mode: 'folder', capture: ['area'] },
  { type: 'worker', pattern: 'src/workers/*', mode: 'folder', capture: ['domain'] },

  { type: 'domain', pattern: 'src/modules/*/domain', mode: 'folder', capture: ['module'] },
  {
    type: 'application',
    pattern: 'src/modules/*/application',
    mode: 'folder',
    capture: ['module'],
  },
  {
    type: 'infrastructure',
    pattern: 'src/modules/*/infrastructure',
    mode: 'folder',
    capture: ['module'],
  },
  {
    type: 'controller',
    pattern: 'src/modules/*/*.@(controller|routes).ts',
    mode: 'full',
    capture: ['module', 'kind'],
  },
  /* Schemas, mappers, errors, events — module-level support files. */
  {
    type: 'module-support',
    pattern: 'src/modules/*/*.ts',
    mode: 'full',
    capture: ['module', 'file'],
  },
];

/** Packages that may only be imported from `platform/` (ER-011, D-004). */
const PLATFORM_ONLY_PACKAGES = [
  'pg',
  'pg-boss',
  'drizzle-orm',
  'drizzle-orm/*',
  'drizzle-kit',
  '@aws-sdk/*',
  'nodemailer',
  'lru-cache',
  '@node-rs/argon2',
];

/** HTTP types the application and domain layers may never see (ER-004). */
const HTTP_PACKAGES = ['fastify', '@fastify/*'];

const ELEMENT_TYPE_RULES = [
  /* The composition root wires everything together; that is its whole job. */
  { from: ['bootstrap'], allow: ['*'] },

  {
    from: ['bff'],
    allow: ['application', 'shared', ['platform', { adapter: 'telemetry' }]],
    message:
      'The BFF adapts, it never decides — it may import application services only, ' +
      'never a repository, a domain entity or the database client (ER-002a, D-036). ' +
      'Found an import of ${dependency.type}.',
  },

  {
    from: ['controller'],
    allow: [
      'application',
      'shared',
      ['module-support', { module: '${from.module}' }],
      ['platform', { adapter: 'telemetry' }],
    ],
    message:
      'A controller validates, calls one application service, and shapes the response ' +
      '(ER-002). It may not import ${dependency.type}.',
  },

  {
    from: ['application'],
    allow: [
      ['domain', { module: '${from.module}' }],
      ['infrastructure', { module: '${from.module}' }],
      ['module-support', { module: '${from.module}' }],
      /* Cross-module access is service to service, never repository to
         repository (ER-007). Note this entry carries no module capture. */
      'application',
      'shared',
      'platform',
    ],
    message:
      'Cross-module access goes through application services; repositories and domain ' +
      'entities are private to their module (ER-007). Found ${dependency.type} ' +
      'from module "${dependency.module}".',
  },

  {
    from: ['domain'],
    allow: [['domain', { module: '${from.module}' }]],
    message:
      'The domain layer imports nothing — no ORM, no framework, no adapter, no platform ' +
      'code (ER-003b). A domain file that cannot be unit tested without a database is ' +
      'not a domain file. Found ${dependency.type}.',
  },

  {
    from: ['infrastructure'],
    allow: [
      ['domain', { module: '${from.module}' }],
      ['module-support', { module: '${from.module}' }],
      'shared',
      'platform',
      'platform-db',
    ],
    message:
      'Repositories construct queries and map rows — no business rules, no permission ' +
      'checks, no cross-module calls (ER-005, ER-007). Found ${dependency.type}.',
  },

  {
    from: ['worker'],
    allow: ['application', 'shared', 'platform'],
    message:
      'A worker binds tenant context and calls an application service, exactly like the ' +
      'API (ER-043). It may not import ${dependency.type}.',
  },

  { from: ['platform', 'platform-db'], allow: ['platform', 'platform-db', 'shared'] },
  { from: ['shared'], allow: ['shared'] },
  {
    from: ['module-support'],
    allow: [['domain', { module: '${from.module}' }], 'shared'],
  },

  /* Explicit disallows for the cases worth explaining. Everything not allowed
     above is already denied by `default: 'disallow'`; these entries exist only
     so the error message carries the reason rather than a bare layer name.
     They must come last — a later matching rule wins. */
  {
    from: ['bff'],
    disallow: ['infrastructure', 'domain', 'platform-db'],
    message:
      'The BFF adapts, it never decides (ER-002a, D-036). It may import application ' +
      'services only — never a repository, a domain entity, or the database client. ' +
      'If a rule appears in src/bff/, it is in the wrong layer: move it down, do not ' +
      'duplicate it. Found ${dependency.type}.',
  },
  {
    from: ['controller'],
    disallow: ['infrastructure', 'domain', 'platform-db'],
    message:
      'A controller validates input, calls one application service, and shapes the ' +
      'response (ER-002). Never reach the database outside a repository (ER-006). ' +
      'Found ${dependency.type}.',
  },
  {
    from: ['domain'],
    disallow: ['platform', 'platform-db', 'shared', 'infrastructure', 'application', 'controller'],
    message:
      'The domain layer imports nothing — no ORM, no framework, no adapter, no platform ' +
      'code (ER-003b). A domain file that cannot be unit tested without a database is ' +
      'not a domain file. Found ${dependency.type}.',
  },
  {
    from: ['application'],
    disallow: [
      ['infrastructure', { module: '!(${from.module})' }],
      ['domain', { module: '!(${from.module})' }],
    ],
    message:
      'Cross-module access goes through application services, never repository to ' +
      'repository (ER-007). Repositories and domain entities are private to their ' +
      'module — call module "${dependency.module}"\'s application service instead.',
  },
];

const EXTERNAL_RULES = [
  {
    from: ['domain'],
    disallow: ['*', '@*/*'],
    message:
      'The domain layer imports nothing external (ER-003b, D-037). "${dependency.source}" ' +
      'belongs behind a port, and the invariant belongs in a file that can be tested ' +
      'without one.',
  },
  {
    from: ['bff', 'controller', 'application', 'module-support', 'shared', 'worker'],
    disallow: PLATFORM_ONLY_PACKAGES,
    message:
      'External SDKs appear only in platform/ (ER-011, D-004). "${dependency.source}" must ' +
      'sit behind a port so the on-premise implementation can differ and tests can fake it.',
  },
  {
    from: ['application', 'infrastructure'],
    disallow: HTTP_PACKAGES,
    message:
      'The application and domain layers never import HTTP types (ER-004) — that is what ' +
      'makes them callable from a worker. Found "${dependency.source}".',
  },
];

/**
 * @param {{ rootPath?: string, files: string[] }} options
 * @returns {import('eslint').Linter.Config}
 */
export function boundariesConfig({ rootPath, files }) {
  return {
    files,
    plugins: { boundaries },
    settings: {
      ...(rootPath === undefined ? {} : { 'boundaries/root-path': rootPath }),
      'boundaries/elements': ELEMENTS,
      'boundaries/include': ['src/**/*.ts'],
      'boundaries/dependency-nodes': ['import', 'dynamic-import', 'require'],
      /* Maps NodeNext's `./x.js` specifiers onto `./x.ts` sources. Without it
         nothing resolves and the layer rules never fire — see the file. */
      'import/resolver': { './eslint.resolver.cjs': {} },
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          message:
            'Dependencies point downward only (ER-001): ${file.type} may not import ${dependency.type}.',
          rules: ELEMENT_TYPE_RULES,
        },
      ],
      'boundaries/external': ['error', { default: 'allow', rules: EXTERNAL_RULES }],

      /* D-044 — platform/db exposes only its port implementation and the
         TxScope unwrap. The pool and the Drizzle instance are unreachable, so
         no repository can obtain an unbound client and run a query outside a
         tenant-scoped transaction. */
      'boundaries/entry-point': [
        'error',
        {
          default: 'allow',
          rules: [
            {
              target: ['platform-db'],
              disallow: ['*'],
              message:
                'platform/db exposes only unit-of-work.ts and tx-scope.ts (D-044). ' +
                'The pool and the Drizzle client are deliberately unreachable — obtain a ' +
                'transaction through UnitOfWorkPort and pass the TxScope down (ER-004a).',
            },
            { target: ['platform-db'], allow: ['unit-of-work.ts', 'tx-scope.ts'] },
          ],
        },
      ],
      /* A file belonging to no element is a file no rule constrains. */
      'boundaries/no-unknown-files': 'error',
      'boundaries/no-unknown': 'error',
    },
  };
}
