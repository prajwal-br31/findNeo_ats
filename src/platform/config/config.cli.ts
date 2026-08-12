/**
 * `pnpm config:check` — loads and validates configuration, then prints a
 * redacted summary. Exits non-zero with every problem listed when invalid.
 *
 * This is the same code path the API and worker take at startup, so a green
 * run here means both processes will get past config validation.
 */

import { ConfigValidationError, describeConfig, loadConfig } from './config.js';

function main(): void {
  try {
    const summary = describeConfig(loadConfig());
    const width = Math.max(...Object.keys(summary).map((key) => key.length));

    process.stdout.write('Configuration OK\n\n');
    for (const [key, value] of Object.entries(summary)) {
      process.stdout.write(`  ${key.padEnd(width)}  ${value}\n`);
    }
    process.stdout.write('\n');
  } catch (error) {
    if (!(error instanceof ConfigValidationError)) throw error;

    process.stderr.write(
      `Configuration is invalid — ${String(error.problems.length)} problem(s):\n\n`,
    );
    for (const problem of error.problems) {
      process.stderr.write(`  - ${problem}\n`);
    }
    process.stderr.write(
      '\nSee .env.example and README.md. Run `pnpm db:setup` to generate a .env.\n',
    );
    process.exitCode = 1;
  }
}

main();
