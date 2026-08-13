import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { GLOBAL_SCOPE, tenantScope } from '../../shared/ports/cache.js';
import { assertValidStorageKey, StorageKeyError } from '../../shared/ports/storage.js';
import { unsafeCompanyId } from '../../shared/types/ids.js';
import { describeStorageConformance } from '../../testing/conformance/storage-conformance.js';
import { FakeClock } from '../../testing/fakes/fake-clock.js';
import { FakeMail } from '../../testing/fakes/fake-mail.js';
import { FakeStorage } from '../../testing/fakes/fake-storage.js';
import { LruCacheAdapter } from '../cache/lru-cache-adapter.js';
import { SystemClock } from '../clock/system-clock.js';
import { LogMailAdapter } from '../mail/log-mail-adapter.js';
import { FilesystemStorage } from '../storage/filesystem-storage.js';

/** T-008 — the five ports (D-004). */

const temporaryRoots: string[] = [];

afterAll(async () => {
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
});

/* The same suite runs against both implementations, which is what makes it a
   contract rather than a description of one of them. The S3 adapter must pass
   it unchanged in Phase 3. */
describeStorageConformance('FilesystemStorage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'findneo-storage-'));
  temporaryRoots.push(root);
  return new FilesystemStorage(root);
});

describeStorageConformance('FakeStorage', () => new FakeStorage());

describe('storage key validation (SEC-043)', () => {
  it('accepts a server-generated key', () => {
    expect(() => {
      assertValidStorageKey('companies/0192f/resumes/0192a.pdf');
    }).not.toThrow();
  });

  it.each([
    ['/absolute', '/a'],
    ['traversal', 'a/../b'],
    ['leading traversal', '../a'],
    ['drive letter', 'C:/a'],
    ['double slash', 'a//b'],
    ['empty', ''],
  ])('rejects %s', (_label, key) => {
    expect(() => {
      assertValidStorageKey(key);
    }).toThrow(StorageKeyError);
  });
});

describe('CachePort keys the tenant structurally (ER-024, SEC-008)', () => {
  const alpha = unsafeCompanyId('01920000-0000-7000-8000-0000000000a1');
  const beta = unsafeCompanyId('01920000-0000-7000-8000-0000000000b2');
  let cache: LruCacheAdapter;

  beforeEach(() => {
    cache = new LruCacheAdapter();
  });

  it('one tenant cannot read another tenant under the same key', () => {
    cache.set(tenantScope(alpha), 'permissions', ['jobs.read']);
    expect(cache.get(tenantScope(beta), 'permissions')).toBeUndefined();
  });

  it('a tenant entry does not collide with the global entry', () => {
    cache.set(tenantScope(alpha), 'catalog', 'tenant');
    cache.set(GLOBAL_SCOPE, 'catalog', 'global');
    expect(cache.get(tenantScope(alpha), 'catalog')).toBe('tenant');
    expect(cache.get(GLOBAL_SCOPE, 'catalog')).toBe('global');
  });

  it('round-trips falsy values rather than reading them as a miss', () => {
    cache.set(tenantScope(alpha), 'flag', false);
    cache.set(tenantScope(alpha), 'count', 0);
    expect(cache.get(tenantScope(alpha), 'flag')).toBe(false);
    expect(cache.get(tenantScope(alpha), 'count')).toBe(0);
  });
});

describe('CachePort invalidation and scoping', () => {
  const alpha = unsafeCompanyId('01920000-0000-7000-8000-0000000000a1');
  const beta = unsafeCompanyId('01920000-0000-7000-8000-0000000000b2');
  let cache: LruCacheAdapter;

  beforeEach(() => {
    cache = new LruCacheAdapter();
  });

  it('invalidateScope drops one tenant and leaves the others', () => {
    cache.set(tenantScope(alpha), 'a', 1);
    cache.set(tenantScope(beta), 'a', 2);
    cache.set(GLOBAL_SCOPE, 'a', 3);

    cache.invalidateScope(tenantScope(alpha));

    expect(cache.get(tenantScope(alpha), 'a')).toBeUndefined();
    expect(cache.get(tenantScope(beta), 'a')).toBe(2);
    expect(cache.get(GLOBAL_SCOPE, 'a')).toBe(3);
  });

  it('a key that embeds another tenant id cannot reach that tenant', () => {
    /* The scope is a parameter, not a substring, so a caller cannot forge one
       by crafting the key — which is what "structurally required" means. */
    cache.set(tenantScope(alpha), 'x', 'alpha value');
    expect(cache.get(tenantScope(beta), `t:${alpha}\u0000x`)).toBeUndefined();
  });

  it('honours a per-entry TTL', () => {
    cache.set(tenantScope(alpha), 'short', 'v', 1);
    expect(cache.get(tenantScope(alpha), 'short')).toBe('v');
  });
});

describe('MailPort keeps personal data out of logs (ER-048, SEC-033)', () => {
  const message = {
    to: 'candidate@example.com',
    templateId: 'application.received',
    variables: { firstName: 'Ada', salary: '120000' },
  };

  it('the log driver logs ids only — never the recipient or the variables', async () => {
    const lines: string[] = [];
    const mail = new LogMailAdapter((line) => lines.push(line));

    const sent = await mail.send(message);

    const logged = lines.join('\n');
    expect(logged).toContain('application.received');
    expect(logged).toContain(sent.messageId);
    for (const personal of ['candidate@example.com', 'Ada', '120000']) {
      expect(logged).not.toContain(personal);
    }
  });

  it('retains recent messages for the development-only endpoint', async () => {
    const mail = new LogMailAdapter();
    await mail.send(message);
    expect(mail.recent()[0]?.templateId).toBe('application.received');
  });

  it('the fake lets a test assert on recipients and template ids', async () => {
    const mail = new FakeMail();
    await mail.send(message);
    expect(mail.templateIds()).toEqual(['application.received']);
    expect(mail.sentTo('candidate@example.com')).toHaveLength(1);
  });
});

describe('ClockPort is injectable so time is testable without sleeping', () => {
  it('the system clock returns the current time', () => {
    const before = Date.now();
    expect(new SystemClock().now().getTime()).toBeGreaterThanOrEqual(before);
  });

  it('the fake advances on demand', () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    clock.advanceDays(180);
    expect(clock.now().toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });

  it('the fake does not hand out a mutable reference to its own instant', () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
    clock.now().setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});
