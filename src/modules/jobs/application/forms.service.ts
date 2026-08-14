import { Ajv, type ValidateFunction } from 'ajv';
import { fullFormats } from 'ajv-formats/dist/formats.js';

import { BusinessRuleError, ValidationError } from '../../../shared/errors/app-error.js';
import { tenantScope, type CachePort } from '../../../shared/ports/cache.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';
import {
  compileFields,
  FormCompilationError,
  MAX_CUSTOM_FIELDS_BYTES,
  validateFieldDefinitions,
  type CompiledSchema,
  type FormTemplateField,
} from '../form-schema.compiler.js';
import type {
  FormsRepository,
  TemplateRow,
  VersionRow,
} from '../infrastructure/forms.repository.js';

/**
 * Form templates and custom-field validation (T-041, T-042).
 *
 * The compiled schema is cached per `(companyId, versionId)`. Version id is
 * part of the key, so **publishing invalidates naturally** — a new version has
 * a new id and therefore a new key, and no eviction call can be forgotten.
 */

const CACHE_TTL_MS = 30 * 60 * 1000;

/* Formats are opt-in on Ajv 8. Without `date` registered, `format: 'date'` is
   silently ignored and every date field accepts any string — a validation gap
   that looks exactly like working validation.

   Only the formats the compiler can emit are registered, rather than the whole
   set: an unused format is a regex nobody reviewed running on user input. */
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat('date', fullFormats.date);

export interface FormsServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: FormsRepository;
  readonly cache: CachePort;
}

export interface FieldDefinitionInput extends FormTemplateField {
  readonly label: string;
  readonly sequenceOrder: number;
}

export class FormsService {
  readonly #deps: FormsServiceDeps;
  /** Compiled validators, keyed by version id. Compilation is not free. */
  readonly #validators = new Map<string, ValidateFunction>();

  constructor(deps: FormsServiceDeps) {
    this.#deps = deps;
  }

  async listTemplates(companyId: CompanyId): Promise<TemplateRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => repository.listTemplates(tx));
  }

  /**
   * The active version, inside an existing transaction.
   *
   * Job creation pins this id onto the row it is about to insert, so the
   * resolution and the insert must see the same snapshot — a version published
   * between the two would pin a job to a version that was never active for it.
   */
  async activeVersionIn(tx: TxScope, entityType: string): Promise<VersionRow> {
    const version = await this.#deps.repository.activeVersion(tx, entityType);
    if (version === undefined) {
      throw new BusinessRuleError('BR-046', 'No active form template for this entity type.');
    }
    return version;
  }

  /** What the frontend renders from. Adding a field needs no frontend release. */
  async activeVersion(
    companyId: CompanyId,
    entityType: string,
  ): Promise<{ version: VersionRow; fields: FormTemplateField[] }> {
    const { uow, repository } = this.#deps;

    return uow.withTenant(companyId, async (tx: TxScope) => {
      const version = await repository.activeVersion(tx, entityType);
      if (version === undefined) {
        throw new BusinessRuleError('BR-046', 'No active form template for this entity type.');
      }
      return { version, fields: await repository.fieldsFor(tx, version.id) };
    });
  }

  async createTemplate(
    companyId: CompanyId,
    createdBy: UserId,
    entityType: string,
    name: string,
  ): Promise<{ id: string }> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) =>
      repository.createTemplate(tx, companyId, entityType, name, createdBy),
    );
  }

  async createVersion(companyId: CompanyId, templateId: string): Promise<{ id: string }> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) =>
      repository.createVersion(tx, companyId, templateId),
    );
  }

  /** Draft only — editing a published version is 409 (08 §7). */
  async replaceFields(
    companyId: CompanyId,
    versionId: string,
    fields: readonly FieldDefinitionInput[],
  ): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const version = await repository.findVersion(tx, versionId);
      if (version === undefined) throw new BusinessRuleError('BR-046', 'Version not found.');
      if (version.status !== 'draft') {
        throw new BusinessRuleError(
          'BR-046',
          'Only a draft version can be edited. Create a new version instead.',
        );
      }

      const problems = validateFieldDefinitions(fields);
      if (problems.length > 0) {
        throw new ValidationError(
          problems.map((problem) => ({
            path: '/fields',
            code: 'ERR_FIELD_INVALID',
            message: problem,
          })),
        );
      }

      await repository.replaceFields(tx, companyId, versionId, fields);
    });
  }

  /**
   * Publishes a version (08 §4).
   *
   * **Compilation happens before the archive/publish pair**, so an invalid
   * definition can never reach a live form — the transaction never gets far
   * enough to commit one.
   */
  async publishVersion(
    companyId: CompanyId,
    versionId: string,
    publishedBy: UserId,
  ): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const version = await repository.findVersion(tx, versionId);
      if (version === undefined) throw new BusinessRuleError('BR-046', 'Version not found.');
      if (version.status !== 'draft') {
        throw new BusinessRuleError('BR-046', 'Only a draft version can be published.');
      }

      const fields = await repository.fieldsFor(tx, versionId);
      try {
        compileFields(fields);
      } catch (error) {
        if (error instanceof FormCompilationError) {
          throw new ValidationError(
            error.problems.map((problem) => ({
              path: '/fields',
              code: 'ERR_FIELD_INVALID',
              message: problem,
            })),
          );
        }
        throw error;
      }

      /* Archive first: `ux_form_versions_published` permits exactly one
         published version per template, so publishing before archiving
         violates it mid-transaction. */
      await repository.archivePublished(tx, version.templateId);
      if ((await repository.markPublished(tx, versionId, publishedBy)) !== 1) {
        throw new BusinessRuleError('BR-046', 'Version could not be published.');
      }
    });
  }

  /**
   * Validates a `custom_fields` payload against a pinned version's schema.
   *
   * The 32 KB cap is checked first and separately: it is a payload-size limit
   * (BR-048), not a schema failure, and it carries its own status.
   */
  async validateCustomFields(
    tx: TxScope,
    companyId: CompanyId,
    versionId: string,
    payload: unknown,
  ): Promise<void> {
    const serialized = JSON.stringify(payload ?? {});
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CUSTOM_FIELDS_BYTES) {
      throw new BusinessRuleError(
        'BR-048',
        `custom fields exceed the ${String(MAX_CUSTOM_FIELDS_BYTES)} byte limit`,
      );
    }

    const validate = await this.#validatorFor(tx, companyId, versionId);
    if (validate(payload ?? {})) return;

    /* Per-field JSON Pointers, so the client can attach each message to the
       input that produced it — the same shape a static route's failures take. */
    throw new ValidationError(
      (validate.errors ?? []).map((error) => ({
        path: `/customFields${error.instancePath}`,
        code: 'ERR_FIELD_INVALID',
        message: error.message ?? 'is invalid',
      })),
    );
  }

  async #validatorFor(
    tx: TxScope,
    companyId: CompanyId,
    versionId: string,
  ): Promise<ValidateFunction> {
    const cached = this.#validators.get(versionId);
    if (cached !== undefined) return cached;

    const { repository, cache } = this.#deps;
    const scope = tenantScope(companyId);
    const key = `form-schema:${versionId}`;

    const stored = cache.get(scope, key);
    const schema = isCompiledSchema(stored)
      ? stored
      : compileFields(await repository.fieldsFor(tx, versionId));

    cache.set(scope, key, schema, CACHE_TTL_MS);
    const validate = ajv.compile(schema);
    this.#validators.set(versionId, validate);
    return validate;
  }
}

function isCompiledSchema(value: unknown): value is CompiledSchema {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { type?: unknown; properties?: unknown };
  return candidate.type === 'object' && typeof candidate.properties === 'object';
}
