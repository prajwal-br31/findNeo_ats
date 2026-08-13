import {
  ObjectNotFoundError,
  assertValidStorageKey,
  type StoragePort,
  type StoredObject,
} from '../../shared/ports/storage.js';

/**
 * In-memory `StoragePort` (11 §7).
 *
 * Validates keys exactly as a real adapter does, so a traversal bug cannot
 * pass in tests and fail in production. It is a fake, not a permissive stub.
 */

/**
 * A promise-returning method must **reject**, never throw synchronously.
 *
 * The conformance suite caught this: the filesystem adapter's `async` methods
 * turned a key-validation error into a rejection, while this fake threw before
 * its promise existed. A caller using `.catch()` would have seen the error in
 * production and missed it in tests — which is the precise failure a fake is
 * supposed to make impossible.
 */
function guarded<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
export class FakeStorage implements StoragePort {
  readonly #objects = new Map<string, { body: Buffer; contentType: string }>();

  put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    return guarded(() => {
      assertValidStorageKey(key);
      // Copied, so a caller mutating its buffer afterwards cannot alter what
      // is "stored" — S3 and a filesystem both take a snapshot.
      this.#objects.set(key, { body: Buffer.from(body), contentType });
      return { key, size: body.byteLength, contentType };
    });
  }

  get(key: string): Promise<Buffer> {
    return guarded(() => {
      assertValidStorageKey(key);
      const found = this.#objects.get(key);
      if (found === undefined) throw new ObjectNotFoundError(key);
      return Buffer.from(found.body);
    });
  }

  head(key: string): Promise<StoredObject | undefined> {
    return guarded(() => {
      assertValidStorageKey(key);
      const found = this.#objects.get(key);
      return found === undefined
        ? undefined
        : { key, size: found.body.byteLength, contentType: found.contentType };
    });
  }

  async copy(sourceKey: string, destinationKey: string): Promise<StoredObject> {
    await guarded(() => {
      assertValidStorageKey(sourceKey);
    });
    const source = this.#objects.get(sourceKey);
    if (source === undefined) throw new ObjectNotFoundError(sourceKey);
    return this.put(destinationKey, source.body, source.contentType);
  }

  delete(key: string): Promise<void> {
    return guarded(() => {
      assertValidStorageKey(key);
      this.#objects.delete(key);
    });
  }

  reset(): void {
    this.#objects.clear();
  }
}
