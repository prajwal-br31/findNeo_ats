/**
 * `StoragePort` (D-004).
 *
 * One interface, two deployments: S3 for the hosted product, filesystem or
 * MinIO on-premise. Phase 0 ships the filesystem implementation; the S3
 * adapter arrives in Phase 3 and must pass the same conformance suite
 * unchanged — that suite is the contract, not this comment.
 *
 * **Keys are server-generated, never client-supplied** (SEC-043). A client
 * filename in a storage key is path traversal, so implementations reject any
 * key that could escape the root. The conformance suite tests that.
 */

export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
}

export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageKeyError';
  }
}

export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`no object at key "${key}"`);
    this.name = 'ObjectNotFoundError';
  }
}

export interface StoragePort {
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  /** @throws {ObjectNotFoundError} */
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<StoredObject | undefined>;
  /**
   * Server-side copy. D-011 freezes a resume per application by copying the
   * object to a new key, so a later profile update cannot alter what a hiring
   * team already evaluated.
   *
   * @throws {ObjectNotFoundError}
   */
  copy(sourceKey: string, destinationKey: string): Promise<StoredObject>;
  delete(key: string): Promise<void>;
}

/**
 * Shared by every implementation, so the rule cannot drift between them.
 *
 * Rejects absolute paths, parent traversal, backslashes (which are a path
 * separator on Windows and a literal elsewhere — the ambiguity is the danger),
 * NUL bytes, and empty segments.
 *
 * @throws {StorageKeyError}
 */
export function assertValidStorageKey(key: string): void {
  const invalid = (why: string): never => {
    throw new StorageKeyError(`invalid storage key: ${why}`);
  };

  if (key === '') invalid('empty');
  if (key.startsWith('/')) invalid('absolute');
  /* Written as code points so no escaping layer can eat them. A backslash
     is a path separator on Windows and a literal character elsewhere, and
     that ambiguity is exactly what makes it dangerous inside a key. */
  if (key.includes(String.fromCharCode(92))) invalid('contains a backslash');
  if (key.includes(String.fromCharCode(0))) invalid('contains a NUL byte');
  if (/^[a-zA-Z]:/.test(key)) invalid('looks like a drive-letter path');
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      invalid('contains an empty or traversing path segment');
    }
  }
}
