import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import {
  ObjectNotFoundError,
  StorageKeyError,
  assertValidStorageKey,
  type StoragePort,
  type StoredObject,
} from '../../shared/ports/storage.js';

/**
 * Filesystem `StoragePort` — the on-premise implementation for customers who
 * will not run object storage at all (D-004).
 *
 * Content types are stored beside each object in a sidecar, because a
 * filesystem has nowhere else to put them and the port promises to return what
 * was stored. S3 carries them natively; the conformance suite asserts the
 * behaviour, not the mechanism.
 */

const CONTENT_TYPE_SUFFIX = '.contenttype';

export class FilesystemStorage implements StoragePort {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  /**
   * Belt and braces over `assertValidStorageKey`: the key is validated, and
   * then the resolved path is checked to be inside the root regardless.
   * Traversal is the failure that matters here (SEC-043), so it is checked
   * twice by two different mechanisms rather than once cleverly.
   */
  #pathFor(key: string): string {
    assertValidStorageKey(key);
    const full = resolve(join(this.#root, key));
    if (full !== this.#root && !full.startsWith(this.#root + sep)) {
      throw new StorageKeyError('invalid storage key: resolves outside the storage root');
    }
    return full;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const path = this.#pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    await writeFile(`${path}${CONTENT_TYPE_SUFFIX}`, contentType, 'utf8');
    return { key, size: body.byteLength, contentType };
  }

  async get(key: string): Promise<Buffer> {
    const path = this.#pathFor(key);
    try {
      return await readFile(path);
    } catch {
      throw new ObjectNotFoundError(key);
    }
  }

  async head(key: string): Promise<StoredObject | undefined> {
    const path = this.#pathFor(key);
    try {
      const stats = await stat(path);
      const contentType = await readFile(`${path}${CONTENT_TYPE_SUFFIX}`, 'utf8').catch(
        () => 'application/octet-stream',
      );
      return { key, size: stats.size, contentType };
    } catch {
      return undefined;
    }
  }

  async copy(sourceKey: string, destinationKey: string): Promise<StoredObject> {
    const source = await this.head(sourceKey);
    if (source === undefined) throw new ObjectNotFoundError(sourceKey);
    const body = await this.get(sourceKey);
    return this.put(destinationKey, body, source.contentType);
  }

  async delete(key: string): Promise<void> {
    const path = this.#pathFor(key);
    // Idempotent: deleting what is not there is success, as it is on S3.
    await rm(path, { force: true });
    await rm(`${path}${CONTENT_TYPE_SUFFIX}`, { force: true });
  }
}
