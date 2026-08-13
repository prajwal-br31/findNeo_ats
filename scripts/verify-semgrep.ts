/**
 * T-003 gate evidence — proves the seven Semgrep rules fire on planted violations.
 *
 * Phase 0 gate: "Semgrep rules fire on deliberately planted violations."
 *
 * Asserts in both directions, like the boundary check: every planted violation
 * must produce its rule, and every control file — legal code that resembles a
 * violation — must produce nothing. Rule 7 in particular is easy to write so
 * broadly that `tokenType === 'bearer'` trips it, which would train everyone to
 * ignore the rule.
 *
 * Uses a local `semgrep` if one is on PATH, and falls back to the official
 * Docker image otherwise. On Windows, `pip install semgrep` into a virtualenv
 * works and is the faster path; CI uses whichever the runner provides.
 */

import { spawnSync } from 'node:child_process';

interface SemgrepFinding {
  readonly check_id: string;
  readonly path: string;
}

interface SemgrepOutput {
  readonly results: readonly SemgrepFinding[];
  readonly errors: readonly { readonly message?: string }[];
}

const RULES_FILE = 'semgrep/findneo.yml';
const FIXTURE_ROOT = 'fixtures/semgrep';

const EXPECTED: ReadonlyArray<{ file: string; rule: string; why: string }> = [
  {
    file: 'src/modules/example/application/rule1-sql-interpolation.ts',
    rule: 'findneo-raw-sql-interpolation',
    why: 'ER-031 — SQL built by interpolation',
  },
  {
    file: 'src/modules/example/application/rule2-db-outside-repository.ts',
    rule: 'findneo-database-access-outside-repository',
    why: 'ER-006 — ORM call outside a repository',
  },
  {
    file: 'src/modules/example/application/rule3-external-sdk.ts',
    rule: 'findneo-external-sdk-outside-platform',
    why: 'ER-011 — SDK via static import',
  },
  {
    file: 'src/modules/example/application/rule3-external-sdk-sideeffect.ts',
    rule: 'findneo-external-sdk-outside-platform',
    why: 'ER-011 — SDK via side-effect import',
  },
  {
    file: 'src/modules/example/application/rule3-external-sdk-require.ts',
    rule: 'findneo-external-sdk-outside-platform',
    why: 'ER-011 — SDK via require()',
  },
  {
    file: 'src/modules/example/application/rule3-external-sdk-dynamic.ts',
    rule: 'findneo-external-sdk-outside-platform',
    why: 'ER-011 — SDK via dynamic import()',
  },
  {
    file: 'src/modules/example/example.mapper.ts',
    rule: 'findneo-spread-into-response',
    why: 'ER-025 — row spread into a response',
  },
  {
    file: 'src/modules/example/rule5-company-id.controller.ts',
    rule: 'findneo-company-id-from-client',
    why: 'ER-023 — companyId taken from the client',
  },
  {
    file: 'src/modules/example/infrastructure/rule6-set-not-local.ts',
    rule: 'findneo-tenant-binding-not-transaction-local',
    why: 'ER-018 — tenant binding not transaction-local',
  },
  {
    file: 'src/modules/example/application/rule7-secret-comparison.ts',
    rule: 'findneo-non-constant-time-secret-comparison',
    why: 'ER-052 — secret compared with ===',
  },
];

const CONTROLS: readonly string[] = [
  'src/modules/example/infrastructure/control-parameterised.ts',
  'src/modules/example/infrastructure/control-repository-uses-drizzle.ts',
  'src/platform/db/control-platform-may-import-pg.ts',
  'src/modules/example/control-explicit-mapper.mapper.ts',
  'src/modules/example/application/control-safe-comparisons.ts',
];

function hasLocalSemgrep(): boolean {
  const probe = spawnSync('semgrep', ['--version'], { encoding: 'utf8', shell: true });
  return probe.status === 0;
}

function runSemgrep(): SemgrepOutput {
  const args = ['scan', '--config', RULES_FILE, '--json', '--metrics=off', '--quiet', FIXTURE_ROOT];
  const local = hasLocalSemgrep();

  const result = local
    ? spawnSync('semgrep', args, { encoding: 'utf8', shell: true, maxBuffer: 32 * 1024 * 1024 })
    : spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${process.cwd()}:/src`,
          '-w',
          '/src',
          'semgrep/semgrep:latest',
          'semgrep',
          ...args,
        ],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );

  process.stdout.write(`Runner: ${local ? 'local semgrep' : 'docker semgrep/semgrep:latest'}\n\n`);

  /* spawnSync types these as `string`, but yields null or undefined when the
     process could not be spawned at all — which is exactly the
     docker-not-running case this needs to report well. */
  const stdout = result.stdout as string | null | undefined;
  const stderr = result.stderr as string | null | undefined;

  if (typeof stdout !== 'string' || stdout.trim() === '') {
    throw new Error(
      `semgrep produced no output.\n${stderr ?? '(no stderr)'}\n\n` +
        (local
          ? ''
          : 'Docker must be running. Start Docker Desktop, or install semgrep locally.\n'),
    );
  }
  return JSON.parse(stdout) as SemgrepOutput;
}

function normalise(path: string): string {
  const forward = path.replaceAll('\\', '/');
  const index = forward.indexOf(`${FIXTURE_ROOT}/`);
  return index === -1 ? forward : forward.slice(index + FIXTURE_ROOT.length + 1);
}

/** Semgrep prefixes rule ids with the config path; compare on the last segment. */
function ruleName(checkId: string): string {
  const parts = checkId.split('.');
  return parts[parts.length - 1] ?? checkId;
}

function indexFindings(output: SemgrepOutput): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const finding of output.results) {
    const file = normalise(finding.path);
    const rules = byFile.get(file) ?? new Set<string>();
    rules.add(ruleName(finding.check_id));
    byFile.set(file, rules);
  }
  return byFile;
}

function checkExpectations(byFile: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const failures: string[] = [];

  process.stdout.write('Semgrep rules — planted violations:\n');
  for (const expected of EXPECTED) {
    const found = byFile.get(expected.file);
    if (found?.has(expected.rule) === true) {
      process.stdout.write(`  ok   ${expected.why}\n`);
    } else {
      const detail = found === undefined ? 'no findings' : [...found].join(', ');
      process.stdout.write(`  FAIL ${expected.why}\n`);
      failures.push(`${expected.file}: expected ${expected.rule}, got ${detail}`);
    }
  }

  for (const control of CONTROLS) {
    const found = byFile.get(control);
    if (found === undefined) {
      process.stdout.write(`  ok   control clean: ${control}\n`);
    } else {
      failures.push(`${control}: control must be clean, got ${[...found].join(', ')}`);
    }
  }
  return failures;
}

function main(): void {
  const output = runSemgrep();
  const failures = checkExpectations(indexFindings(output));

  for (const error of output.errors) {
    failures.push(`semgrep error: ${error.message ?? 'unknown'}`);
  }

  if (failures.length > 0) {
    process.stderr.write(`\n${String(failures.length)} semgrep check(s) failed:\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `\nAll ${String(EXPECTED.length)} rules fired on their planted violation, ` +
      `all ${String(CONTROLS.length)} controls clean.\n`,
  );
}

main();
