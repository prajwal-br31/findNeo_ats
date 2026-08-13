import PgBoss from 'pg-boss';

import { LruCacheAdapter } from '../platform/cache/lru-cache-adapter.js';
import {
  Argon2PasswordHasher,
  dummyPasswordHash,
} from '../platform/crypto/argon2-password-hasher.js';
import { JwtTokenIssuer } from '../platform/crypto/jwt-token-issuer.js';
import { PgBossQueue } from '../platform/queue/pg-boss-queue.js';
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
import type { PasswordHasherPort } from '../shared/ports/password-hasher.js';
import type { TokenIssuerPort } from '../shared/ports/token-issuer.js';
import type { UnitOfWorkPort } from '../shared/ports/unit-of-work.js';
import { AuthService } from '../modules/identity/application/auth.service.js';
import { AuthController } from '../modules/identity/auth.controller.js';
import { IdentityRepository } from '../modules/identity/infrastructure/identity.repository.js';

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
  readonly hasher: PasswordHasherPort;
  readonly tokens: TokenIssuerPort;
  readonly authController: AuthController;
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

/**
 * The API's queue handle: enqueue-only.
 *
 * `supervise: false` because the API never claims a job - that is the worker's
 * process - and `migrate: false` because installing pg-boss's schema is a
 * migration-step concern needing DDL rights the serving role deliberately does
 * not have (05a 5).
 *
 * A fake would be wrong here. Signup enqueues inside its transaction (ER-028),
 * so a queue that silently accepted and dropped the job would make the
 * verification email vanish on a path no test of signup itself would notice.
 */
async function buildQueue(config: Config): Promise<{ boss: PgBoss; queue: PgBossQueue }> {
  const boss = new PgBoss({
    connectionString: config.database.url,
    schema: 'pgboss',
    supervise: false,
    migrate: false,
    application_name: `findneo-api-${config.nodeEnv}`,
  });
  await boss.start();
  return { boss, queue: new PgBossQueue(boss) };
}

export async function buildContainer(config: Config): Promise<Container> {
  const database: UnitOfWorkHandle = createUnitOfWork({
    url: config.database.url,
    poolMax: config.database.poolMax,
    applicationName: `findneo-api-${config.nodeEnv}`,
  });

  const clock = new SystemClock();
  const hasher = new Argon2PasswordHasher();
  const tokens = new JwtTokenIssuer(config.auth.jwtPrivateKeyPem, clock);

  const { boss, queue } = await buildQueue(config);

  const authController = new AuthController(
    new AuthService({
      uow: database.uow,
      repository: new IdentityRepository(),
      hasher,
      tokens,
      queue,
      clock,
      dummyHash: () => dummyPasswordHash(hasher),
    }),
  );

  return {
    config,
    clock,
    hasher,
    tokens,
    authController,
    cache: new LruCacheAdapter(),
    storage: buildStorage(config),
    mail: buildMail(config),
    uow: database.uow,
    idempotency: new DrizzleIdempotencyStore(),
    close: async (): Promise<void> => {
      await boss.stop({ graceful: false });
      await database.close();
    },
  };
}
