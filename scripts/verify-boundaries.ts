/**
 * T-006a gate evidence — proves the boundary rules reject planted violations.
 *
 * Phase 0 gate:
 *   - "Boundaries linter rejects a controller importing a repository"
 *   - "Linter rejects a BFF file importing a repository, and a domain file
 *      importing Drizzle"
 *
 * A lint config that errors on everything would satisfy a naive check, so this
 * asserts in both directions: every planted violation must produce its expected
 * rule, and every control file must produce nothing. It runs the real
 * `eslint.boundaries.js` objects, rebased onto the fixture tree — not a copy.
 */

import { ESLint } from 'eslint';

interface ExpectedViolation {
  readonly file: string;
  readonly rule: string;
  readonly why: string;
  readonly gate?: boolean;
}

const FIXTURE_ROOT = 'fixtures/boundaries/src';

const EXPECTED_VIOLATIONS: readonly ExpectedViolation[] = [
  {
    file: 'bff/web/bad-bff-imports-repository.ts',
    rule: 'boundaries/element-types',
    why: 'ER-002a — BFF imports a repository',
    gate: true,
  },
  {
    file: 'modules/example/bad.controller.ts',
    rule: 'boundaries/element-types',
    why: 'ER-006 — controller imports a repository',
    gate: true,
  },
  {
    file: 'modules/example/domain/bad-domain-imports-drizzle.ts',
    rule: 'boundaries/external',
    why: 'ER-003b — domain imports Drizzle',
    gate: true,
  },
  {
    file: 'bff/web/bad-bff-imports-database-client.ts',
    rule: 'boundaries/element-types',
    why: 'ER-002a — BFF imports the database client',
  },
  {
    file: 'modules/example/domain/bad-domain-imports-platform.ts',
    rule: 'boundaries/element-types',
    why: 'ER-003b — domain imports platform code',
  },
  {
    file: 'modules/other/application/bad-cross-module-repository.ts',
    rule: 'boundaries/element-types',
    why: "ER-007 — application reaches another module's repository",
  },
  {
    file: 'modules/example/application/bad-imports-pgboss.ts',
    rule: 'boundaries/external',
    why: 'ER-011 — pg-boss imported outside platform/',
  },
  {
    file: 'modules/example/application/bad-imports-pg.ts',
    rule: 'boundaries/external',
    why: 'ER-011 — pg imported outside platform/ (installed package)',
  },
  {
    file: 'modules/example/application/bad-imports-fastify.ts',
    rule: 'boundaries/external',
    why: 'ER-004 — application layer imports an HTTP type',
  },
  {
    file: 'modules/example/infrastructure/bad-imports-db-client.ts',
    rule: 'boundaries/entry-point',
    why: "D-044 — reaching past platform/db's entry point to the raw client",
  },
];

/** Legal code that must lint clean, so a blanket-deny config cannot pass. */
const CONTROLS: readonly string[] = [
  'bff/web/good-bff-imports-application.ts',
  'modules/example/application/good-imports-own-repository.ts',
  'modules/other/application/good-cross-module-service.ts',
  'modules/example/application/good-imports-uow-port.ts',
  'modules/example/infrastructure/good-imports-tx-scope.ts',
];

function toFixtureRelativePath(absolutePath: string): string {
  const normalised = absolutePath.replaceAll('\\', '/');
  const index = normalised.indexOf(`${FIXTURE_ROOT}/`);
  return index === -1 ? normalised : normalised.slice(index + FIXTURE_ROOT.length + 1);
}

async function collectRulesByFile(): Promise<Map<string, Set<string>>> {
  const eslint = new ESLint({ overrideConfigFile: 'eslint.fixtures.config.js' });
  const results = await eslint.lintFiles([`${FIXTURE_ROOT}/**/*.ts`]);

  const byFile = new Map<string, Set<string>>();
  for (const result of results) {
    const rules = new Set<string>();
    for (const message of result.messages) {
      if (message.ruleId !== null) rules.add(message.ruleId);
    }
    byFile.set(toFixtureRelativePath(result.filePath), rules);
  }
  return byFile;
}

function checkViolations(byFile: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const failures: string[] = [];
  for (const expected of EXPECTED_VIOLATIONS) {
    const actual = byFile.get(expected.file);
    const marker = expected.gate === true ? 'GATE ' : '     ';
    if (actual === undefined) {
      failures.push(`${expected.file}: fixture was not linted at all`);
    } else if (!actual.has(expected.rule)) {
      const found = actual.size === 0 ? 'no errors' : [...actual].join(', ');
      failures.push(`${expected.file}: expected ${expected.rule}, got ${found}`);
    } else {
      process.stdout.write(`  ${marker}ok   ${expected.why}\n`);
      continue;
    }
    process.stdout.write(`  ${marker}FAIL ${expected.why}\n`);
  }
  return failures;
}

function checkControls(byFile: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const failures: string[] = [];
  for (const control of CONTROLS) {
    const actual = byFile.get(control);
    if (actual === undefined) {
      failures.push(`${control}: control fixture was not linted`);
    } else if (actual.size > 0) {
      failures.push(`${control}: control must lint clean, got ${[...actual].join(', ')}`);
    } else {
      process.stdout.write(`       ok   control lints clean: ${control}\n`);
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const byFile = await collectRulesByFile();

  process.stdout.write('Boundary rules — planted violations:\n');
  const failures = [...checkViolations(byFile), ...checkControls(byFile)];

  if (failures.length > 0) {
    process.stderr.write(`\n${String(failures.length)} boundary check(s) failed:\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.stderr.write(
      '\nA rule that stops firing is worse than no rule: the layer violation it was ' +
        'meant to catch now passes review silently.\n',
    );
    process.exitCode = 1;
    return;
  }

  const gateCount = EXPECTED_VIOLATIONS.filter((violation) => violation.gate === true).length;
  process.stdout.write(
    `\nAll ${String(EXPECTED_VIOLATIONS.length)} planted violations rejected ` +
      `(${String(gateCount)} named in the Phase 0 gate), ` +
      `all ${String(CONTROLS.length)} controls clean.\n`,
  );
}

await main();
