import { LruCacheAdapter } from '../platform/cache/lru-cache-adapter.js';
import { SystemClock } from '../platform/clock/system-clock.js';
import type { Config } from '../platform/config/config.types.js';
import { DrizzleIdempotencyStore } from '../platform/db/idempotency-store.js';
import { createUnitOfWork, type UnitOfWorkHandle } from '../platform/db/unit-of-work.js';
import { LogMailAdapter } from '../platform/mail/log-mail-adapter.js';
import { FilesystemStorage } from '../platform/storage/filesystem-storage.js';
import type { CachePort } from '../shared/ports/cache.js';
import type { ClockPort } from '../shared/ports/clock.js';
import type { IdempotencyStorePort } from '../shared/ports/idempotency-store.js';
import type { MailPort } from '../shared/ports/mail.js';
import type { StoragePort } from '../shared/ports/storage.js';
import type { UnitOfWorkPort } from '../shared/ports/unit-of-work.js';

/**
 * The composition root (ER-008).
 *
 * The only place that knows which implementation sits behind each port, and
 * the only element the boundaries linter lets import everything (ER-009a).
 * Nothing below it names a concrete adapter — that is what makes the
 * on-premise swap a configuration change rather than a code change (D-002).
 */

export interface Container {
  readonly config: Config;
  readonly clock: ClockPort;
  readonly cache: CachePort;
  readonly storage: StoragePort;
  readonly mail: MailPort;
  readonly uow: UnitOfWorkPort;
  readonly idempotency: IdempotencyStorePort;
  close(): Promise<void>;
}

function buildStorage(config: Config): StoragePort {
  if (config.storage.driver === 'filesystem') return new FilesystemStorage(config.storage.root);
  throw new Error(
    'STORAGE_DRIVER=s3 is not implemented until Phase 3 (T-064). The S3 adapter must pass ' +
      'the StoragePort conformance suite unchanged before it is wired here.',
  );
}

function buildMail(config: Config): MailPort {
  if (config.mail.driver === 'log') return new LogMailAdapter();
  throw new Error(
    'MAIL_DRIVER=smtp is not implemented until Phase 1, when there is a message to send.',
  );
}

export function buildContainer(config: Config): Container {
  const database: UnitOfWorkHandle = createUnitOfWork({
    url: config.database.url,
    poolMax: config.database.poolMax,
    applicationName: `findneo-api-${config.nodeEnv}`,
  });

  return {
    config,
    clock: new SystemClock(),
    cache: new LruCacheAdapter(),
    storage: buildStorage(config),
    mail: buildMail(config),
    uow: database.uow,
    idempotency: new DrizzleIdempotencyStore(),
    close: async (): Promise<void> => {
      await database.close();
    },
  };
}
