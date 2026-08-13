import { describe, expect, it } from 'vitest';

import {
  ObjectNotFoundError,
  StorageKeyError,
  type StoragePort,
} from '../../shared/ports/storage.js';

/**
 * The `StoragePort` contract, as executable tests.
 *
 * Phase 0 ships the filesystem implementation; the S3 adapter arrives in
 * Phase 3 (T-064) and **must pass this suite unchanged**. That is the point of
 * writing it now rather than then: if the contract is only discovered while
 * implementing the second adapter, the first one silently defined it, and
 * whatever it happened to do becomes the spec.
 *
 * Behaviour only — never how it is stored. A test that asserts a file exists
 * on disk cannot be run against S3, and would quietly become filesystem-only.
 *
 * ```ts
 * describeStorageConformance('FilesystemStorage', () => new FilesystemStorage(dir));
 * ```
 */
type Factory = () => StoragePort | Promise<StoragePort>;

const body = Buffer.from('resume bytes');

function describeRoundTrip(create: Factory): void {
  describe('storing and reading', () => {
    it('round-trips an object', async () => {
      const storage = await create();
      await storage.put('a/b/one.pdf', body, 'application/pdf');
      expect(await storage.get('a/b/one.pdf')).toEqual(body);
    });

    it('reports size and content type', async () => {
      const storage = await create();
      const stored = await storage.put('one.pdf', body, 'application/pdf');
      expect(stored).toEqual({
        key: 'one.pdf',
        size: body.byteLength,
        contentType: 'application/pdf',
      });
    });

    it('head returns undefined for a missing object rather than throwing', async () => {
      const storage = await create();
      expect(await storage.head('nope.pdf')).toBeUndefined();
    });

    it('head reports a stored object', async () => {
      const storage = await create();
      await storage.put('one.pdf', body, 'application/pdf');
      expect(await storage.head('one.pdf')).toMatchObject({ contentType: 'application/pdf' });
    });

    it('get throws ObjectNotFoundError for a missing object', async () => {
      const storage = await create();
      await expect(storage.get('nope.pdf')).rejects.toThrow(ObjectNotFoundError);
    });

    it('overwrites an existing key', async () => {
      const storage = await create();
      await storage.put('one.pdf', body, 'application/pdf');
      await storage.put('one.pdf', Buffer.from('replaced'), 'text/plain');
      expect((await storage.get('one.pdf')).toString()).toBe('replaced');
    });
  });
}

function describeCopy(create: Factory): void {
  describe('copying (D-011)', () => {
    it('copies byte-for-byte, carrying the content type (D-011)', async () => {
      const storage = await create();
      await storage.put('profile/cv.pdf', body, 'application/pdf');
      const copied = await storage.copy('profile/cv.pdf', 'applications/1/cv.pdf');

      expect(copied.contentType).toBe('application/pdf');
      expect(await storage.get('applications/1/cv.pdf')).toEqual(body);
    });

    it('a copy is independent of its source — replacing one leaves the other', async () => {
      /* BR-060: replacing a profile resume must leave the application's frozen
         copy byte-identical, which is the whole reason copy() exists. */
      const storage = await create();
      await storage.put('profile/cv.pdf', body, 'application/pdf');
      await storage.copy('profile/cv.pdf', 'applications/1/cv.pdf');
      await storage.put('profile/cv.pdf', Buffer.from('new cv'), 'application/pdf');

      expect(await storage.get('applications/1/cv.pdf')).toEqual(body);
    });

    it('copy throws when the source is missing', async () => {
      const storage = await create();
      await expect(storage.copy('nope.pdf', 'dest.pdf')).rejects.toThrow(ObjectNotFoundError);
    });

    it('delete removes the object', async () => {
      const storage = await create();
      await storage.put('one.pdf', body, 'application/pdf');
      await storage.delete('one.pdf');
      expect(await storage.head('one.pdf')).toBeUndefined();
    });

    it('delete is idempotent', async () => {
      const storage = await create();
      await expect(storage.delete('never-existed.pdf')).resolves.toBeUndefined();
    });
  });
}

function describeKeySafety(create: Factory): void {
  describe('key safety (SEC-043)', () => {
    it.each([
      ['absolute', '/etc/passwd'],
      ['parent traversal', 'a/../../etc/passwd'],
      ['leading traversal', '../secrets'],
      ['a bare dot segment', 'a/./b'],
      ['an empty segment', 'a//b'],
      ['a drive letter', 'C:/Windows/system32'],
      ['empty', ''],
    ])('SEC-043: rejects %s as a key', async (_label, key) => {
      const storage = await create();
      await expect(storage.put(key, body, 'application/pdf')).rejects.toThrow(StorageKeyError);
    });

    it('SEC-043: rejects a backslash, which is a separator on Windows', async () => {
      const storage = await create();
      const key = `a${String.fromCharCode(92)}..${String.fromCharCode(92)}escape`;
      await expect(storage.put(key, body, 'application/pdf')).rejects.toThrow(StorageKeyError);
    });

    it('rejects rather than throwing synchronously, so .catch() sees it', () => {
      /* A promise-returning method that throws before its promise exists is
         invisible to a caller using .catch(). The two implementations differed
         on this until the suite caught it. */
      const storage = create();
      const attempt = Promise.resolve(storage).then(async (s) =>
        s.put('../escape', Buffer.from('x'), 'text/plain'),
      );
      return expect(attempt).rejects.toThrow(StorageKeyError);
    });

    it('SEC-043: a traversing key is rejected on read as well as on write', async () => {
      const storage = await create();
      await expect(storage.get('../../etc/passwd')).rejects.toThrow(StorageKeyError);
    });
  });
}

export function describeStorageConformance(name: string, create: Factory): void {
  describe(`StoragePort conformance: ${name}`, () => {
    describeRoundTrip(create);
    describeCopy(create);
    describeKeySafety(create);
  });
}
