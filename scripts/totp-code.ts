/**
 * Prints a current TOTP code for a base32 secret. Development helper.
 *
 *   node --import tsx scripts/totp-code.ts <base32-secret>
 *
 * Uses the same parameters as `platform/crypto/totp.ts`, so a code it prints
 * is one the server will accept — a helper that guesses at the period or the
 * digit count produces codes that fail for reasons that look like a bug in
 * enrolment.
 */

import { Secret, TOTP } from 'otpauth';

const secret = process.argv[2];
if (secret === undefined || secret === '') {
  process.stderr.write('usage: node --import tsx scripts/totp-code.ts <base32-secret>\n');
  process.exit(1);
}

const totp = new TOTP({
  issuer: 'FindNeo',
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
  secret: Secret.fromBase32(secret),
});

process.stdout.write(`${totp.generate()}\n`);
