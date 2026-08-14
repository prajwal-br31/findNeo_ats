import PgBoss from 'pg-boss';

import { LruCacheAdapter } from '../platform/cache/lru-cache-adapter.js';
import {
  Argon2PasswordHasher,
  dummyPasswordHash,
} from '../platform/crypto/argon2-password-hasher.js';
import { JwtTokenIssuer, JwtTokenVerifier } from '../platform/crypto/jwt-token-issuer.js';
import { SecretBox } from '../platform/crypto/secret-box.js';
import { beginTotpEnrolment, verifyTotp } from '../platform/crypto/totp.js';
import { PgBossQueue } from '../platform/queue/pg-boss-queue.js';
import { SystemClock } from '../platform/clock/system-clock.js';
import type { Config } from '../platform/config/config.types.js';
import { DrizzleIdempotencyStore } from '../platform/db/idempotency-store.js';
import { createUnitOfWork, type UnitOfWorkHandle } from '../platform/db/unit-of-work.js';
import { LogMailAdapter } from '../platform/mail/log-mail-adapter.js';
import { SmtpMailAdapter } from '../platform/mail/smtp-mail-adapter.js';
import { FilesystemStorage } from '../platform/storage/filesystem-storage.js';
import type { CachePort } from '../shared/ports/cache.js';
import type { ClockPort } from '../shared/ports/clock.js';
import type { IdempotencyStorePort } from '../shared/ports/idempotency-store.js';
import type { MailPort } from '../shared/ports/mail.js';
import type { StoragePort } from '../shared/ports/storage.js';
import type { PasswordHasherPort } from '../shared/ports/password-hasher.js';
import type { TokenIssuerPort, TokenVerifierPort } from '../shared/ports/token-issuer.js';
import type { UnitOfWorkPort } from '../shared/ports/unit-of-work.js';
import { AuthService } from '../modules/identity/application/auth.service.js';
import { AuthController } from '../modules/identity/auth.controller.js';
import { IdentityRepository } from '../modules/identity/infrastructure/identity.repository.js';
import { InvitationsService } from '../modules/identity/application/invitations.service.js';
import { InvitationsController } from '../modules/identity/invitations.controller.js';
import { InvitationsRepository } from '../modules/identity/infrastructure/invitations.repository.js';
import { AccessController } from '../modules/identity/access.controller.js';
import { DepartmentsService } from '../modules/identity/application/departments.service.js';
import { FieldVisibilityService } from '../modules/identity/application/field-visibility.service.js';
import { PermissionsService } from '../modules/identity/application/permissions.service.js';
import { PlatformService } from '../modules/identity/application/platform.service.js';
import { RolesService } from '../modules/identity/application/roles.service.js';
import { DepartmentsRepository } from '../modules/identity/infrastructure/departments.repository.js';
import { FieldVisibilityRepository } from '../modules/identity/infrastructure/field-visibility.repository.js';
import { PlatformRepository } from '../modules/identity/infrastructure/platform.repository.js';
import { RolesRepository } from '../modules/identity/infrastructure/roles.repository.js';
import { FormsService } from '../modules/jobs/application/forms.service.js';
import { JobsService } from '../modules/jobs/application/jobs.service.js';
import { PipelineService } from '../modules/jobs/application/pipeline.service.js';
import { FormsRepository } from '../modules/jobs/infrastructure/forms.repository.js';
import { JobsRepository } from '../modules/jobs/infrastructure/jobs.repository.js';
import { PipelineRepository } from '../modules/jobs/infrastructure/pipeline.repository.js';
import { JobsController } from '../modules/jobs/jobs.controller.js';

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
  readonly tokenVerifier: TokenVerifierPort;
  readonly authController: AuthController;
  readonly invitationsController: InvitationsController;
  readonly accessController: AccessController;
  readonly permissionsService: PermissionsService;
  readonly fieldVisibility: FieldVisibilityService;
  readonly jobsController: JobsController;
  close(): Promise<void>;
}

function buildStorage(config: Config): StoragePort {
  if (config.storage.driver === 'filesystem') return new FilesystemStorage(config.storage.root);
  throw new Error(
    'STORAGE_DRIVER=s3 is not implemented until Phase 3 (T-064). The S3 adapter must pass ' +
      'the StoragePort conformance suite unchanged before it is wired here.',
  );
}

/**
 * Async because the SMTP driver authenticates here, at boot.
 *
 * `verify()` opens a connection and logs in, so a wrong password or an
 * unreachable host fails the process start. Deferred to the first send, the
 * same mistake surfaces inside a worker on a job that retries and
 * dead-letters, hours after the deploy that caused it.
 */
async function buildMail(config: Config): Promise<{ mail: MailPort; close: () => Promise<void> }> {
  if (config.mail.driver === 'log') {
    return { mail: new LogMailAdapter(), close: () => Promise.resolve() };
  }

  const smtp = new SmtpMailAdapter({
    host: config.mail.host,
    port: config.mail.port,
    user: config.mail.user,
    password: config.mail.password,
    from: config.mail.from,
  });
  await smtp.verify();
  return { mail: smtp, close: () => smtp.close() };
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

interface IdentityDeps {
  readonly database: UnitOfWorkHandle;
  readonly hasher: Argon2PasswordHasher;
  readonly tokens: JwtTokenIssuer;
  readonly queue: PgBossQueue;
  readonly clock: SystemClock;
  readonly secretBox: SecretBox;
}

/** The identity module's object graph. */
function buildIdentity(deps: IdentityDeps): AuthController {
  const { database, hasher, tokens, queue, clock, secretBox } = deps;

  return new AuthController(
    new AuthService({
      uow: database.uow,
      repository: new IdentityRepository(),
      hasher,
      tokens,
      queue,
      clock,
      dummyHash: () => dummyPasswordHash(hasher),
      /* TOTP and secret encryption reach the application layer as functions
         rather than imports: `otpauth` and node crypto are platform concerns
         (ER-011), and the service should not know which library provides
         them. */
      mfa: {
        begin: (label) => beginTotpEnrolment(label),
        verify: (secret, label, code) => verifyTotp(secret, label, code),
        encrypt: (plaintext) => secretBox.encrypt(plaintext),
        decrypt: (envelope) => secretBox.decrypt(envelope),
      },
    }),
  );
}

/** The invitations module's object graph. */
function buildInvitations(
  config: Config,
  database: UnitOfWorkHandle,
  hasher: Argon2PasswordHasher,
  mail: MailPort,
  clock: SystemClock,
): InvitationsController {
  return new InvitationsController(
    new InvitationsService({
      uow: database.uow,
      invitations: new InvitationsRepository(),
      identity: new IdentityRepository(),
      hasher,
      mail,
      clock,
      /* Where the accept link points. The API's own origin in development;
         the web app's in a real deployment. */
      appBaseUrl: `http://${config.api.host}:${String(config.api.port)}`,
    }),
  );
}

interface AccessGraph {
  readonly controller: AccessController;
  readonly permissions: PermissionsService;
  readonly fieldVisibility: FieldVisibilityService;
}

/** Departments, roles, permissions, masking and the platform surface. */
function buildAccess(
  database: UnitOfWorkHandle,
  cache: LruCacheAdapter,
  clock: SystemClock,
): AccessGraph {
  const permissions = new PermissionsService({
    uow: database.uow,
    repository: new IdentityRepository(),
    cache,
  });

  const controller = new AccessController(
    new DepartmentsService({ uow: database.uow, repository: new DepartmentsRepository() }),
    new RolesService({ uow: database.uow, repository: new RolesRepository(), permissions }),
    new PlatformService({ uow: database.uow, repository: new PlatformRepository(), clock }),
  );

  return {
    controller,
    permissions,
    fieldVisibility: new FieldVisibilityService({
      uow: database.uow,
      repository: new FieldVisibilityRepository(),
      cache,
    }),
  };
}

/** The jobs module's object graph (Phase 2). */
function buildJobs(database: UnitOfWorkHandle, cache: LruCacheAdapter): JobsController {
  const jobsRepository = new JobsRepository();
  const pipelineRepository = new PipelineRepository();

  const forms = new FormsService({
    uow: database.uow,
    repository: new FormsRepository(),
    cache,
  });

  return new JobsController(
    new JobsService({
      uow: database.uow,
      repository: jobsRepository,
      pipeline: pipelineRepository,
      forms,
    }),
    forms,
    new PipelineService({
      uow: database.uow,
      repository: pipelineRepository,
      jobs: jobsRepository,
    }),
  );
}

/** The stateless adapters every module graph is handed. */
function buildPrimitives(config: Config): {
  clock: SystemClock;
  hasher: Argon2PasswordHasher;
  tokens: JwtTokenIssuer;
  tokenVerifier: JwtTokenVerifier;
  secretBox: SecretBox;
} {
  const clock = new SystemClock();
  return {
    clock,
    hasher: new Argon2PasswordHasher(),
    tokens: new JwtTokenIssuer(config.auth.jwtPrivateKeyPem, clock),
    tokenVerifier: new JwtTokenVerifier(config.auth.jwtPublicKeyPem),
    secretBox: new SecretBox(config.auth.secretEncryptionKey),
  };
}

export async function buildContainer(config: Config): Promise<Container> {
  const database: UnitOfWorkHandle = createUnitOfWork({
    url: config.database.url,
    poolMax: config.database.poolMax,
    applicationName: `findneo-api-${config.nodeEnv}`,
  });

  const { clock, hasher, tokens, tokenVerifier, secretBox } = buildPrimitives(config);

  const { boss, queue } = await buildQueue(config);
  const mailHandle = await buildMail(config);

  const authController = buildIdentity({ database, hasher, tokens, queue, clock, secretBox });

  const invitationsController = buildInvitations(config, database, hasher, mailHandle.mail, clock);

  const cache = new LruCacheAdapter();
  const access = buildAccess(database, cache, clock);
  const jobsController = buildJobs(database, cache);

  return {
    config,
    clock,
    hasher,
    tokens,
    tokenVerifier,
    authController,
    invitationsController,
    accessController: access.controller,
    permissionsService: access.permissions,
    fieldVisibility: access.fieldVisibility,
    jobsController,
    cache,
    storage: buildStorage(config),
    mail: mailHandle.mail,
    uow: database.uow,
    idempotency: new DrizzleIdempotencyStore(),
    close: async (): Promise<void> => {
      await boss.stop({ graceful: false });
      await mailHandle.close();
      await database.close();
    },
  };
}
