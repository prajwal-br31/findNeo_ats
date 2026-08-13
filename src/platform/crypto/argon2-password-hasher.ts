import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import type { PasswordHasherPort } from '../../shared/ports/password-hasher.js';

/**
 * argon2id password hashing (SEC-014, 05a §5).
 *
 * OWASP baseline: memory 19456 KiB, iterations 2, parallelism 1. Held here as
 * named constants rather than inline numbers because they are a security
 * parameter someone will need to raise, and a raised parameter that misses one
 * call site is worse than one nobody raised.
 *
 * `@node-rs/argon2` over the `argon2` package: the latter needs a compiler
 * toolchain at install time, which breaks Alpine images and frustrates
 * on-premise installs. Same algorithm, prebuilt binaries.
 */

const ARGON2ID = 2;

export const ARGON2_MEMORY_KIB = 19_456;
export const ARGON2_ITERATIONS = 2;
export const ARGON2_PARALLELISM = 1;

/**
 * A real argon2id hash of a value nobody holds, used by login when the account
 * does not exist so the verification still costs what a real one costs
 * (SEC-015). Generated once at module load rather than per request: hashing it
 * every time would double the work on the miss path and make misses *slower*
 * than hits, which leaks existence just as effectively as being faster.
 */
let dummyHashPromise: Promise<string> | undefined;

export class Argon2PasswordHasher implements PasswordHasherPort {
  async hash(plaintext: string): Promise<string> {
    return argonHash(plaintext, {
      /* 2 is Algorithm.Argon2id. The enum is an ambient const enum, which
         `verbatimModuleSyntax` refuses to inline, so the value is written out
         and named rather than imported. */
      algorithm: ARGON2ID,
      memoryCost: ARGON2_MEMORY_KIB,
      timeCost: ARGON2_ITERATIONS,
      parallelism: ARGON2_PARALLELISM,
    });
  }

  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argonVerify(hash, plaintext);
    } catch {
      /* A malformed or foreign hash is a mismatch, not an exception. Throwing
         here would give the caller a distinguishable outcome — and a
         distinguishable duration — for "no such account". */
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    /* Parsed from the encoded hash rather than trusted: `$argon2id$v=19$m=…,t=…,p=…$…`
       carries the parameters it was produced with, which is the whole reason
       raising them does not invalidate existing passwords. */
    const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
    if (match === null) return true;

    const [, memory, iterations, parallelism] = match;
    return (
      Number(memory) < ARGON2_MEMORY_KIB ||
      Number(iterations) < ARGON2_ITERATIONS ||
      Number(parallelism) < ARGON2_PARALLELISM
    );
  }
}

/**
 * The hash login verifies against when no user matches.
 *
 * Exported from here rather than built in the service so the dummy is produced
 * by the same adapter, with the same parameters, as every real hash. A dummy
 * generated with weaker parameters would verify faster than a real one and
 * reintroduce the timing signal it exists to remove.
 */
export function dummyPasswordHash(hasher: PasswordHasherPort): Promise<string> {
  dummyHashPromise ??= hasher.hash('findneo-nonexistent-account-placeholder');
  return dummyHashPromise;
}
