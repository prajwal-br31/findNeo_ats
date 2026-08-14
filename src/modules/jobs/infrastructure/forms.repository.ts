import { sql } from 'drizzle-orm';

import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';
import type { FormTemplateField } from '../form-schema.compiler.js';

/** Form template persistence (T-041, 06 §5). */

export interface TemplateRow extends Record<string, unknown> {
  readonly id: string;
  readonly companyId: string | null;
  readonly entityType: string;
  readonly name: string;
  readonly status: string;
}

export interface VersionRow extends Record<string, unknown> {
  readonly id: string;
  readonly templateId: string;
  readonly versionNo: number;
  readonly status: string;
  readonly companyId: string | null;
}

interface FieldRow extends Record<string, unknown> {
  readonly key: string;
  readonly dataType: FormTemplateField['dataType'];
  readonly isRequired: boolean;
  readonly options: unknown;
  readonly maxLength: number | null;
  readonly minValue: string | number | null;
  readonly maxValue: string | number | null;
}

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

function toOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export class FormsRepository {
  async listTemplates(tx: TxScope): Promise<TemplateRow[]> {
    const result = await unwrapTxScope(tx).execute<TemplateRow>(sql`
      select id, company_id as "companyId", entity_type as "entityType", name, status
        from form_templates order by company_id nulls first, entity_type
    `);
    return result.rows;
  }

  /**
   * The active version for an entity type: the company's published version if
   * it has one, otherwise the platform default.
   *
   * `ORDER BY company_id NULLS LAST LIMIT 1` resolves precedence in SQL, so
   * the rule lives in one place. The department branch (D-028b) is
   * unreachable in v1 and deliberately absent rather than written and dead.
   */
  async activeVersion(tx: TxScope, entityType: string): Promise<VersionRow | undefined> {
    const result = await unwrapTxScope(tx).execute<VersionRow>(sql`
      select v.id, v.template_id as "templateId", v.version_no as "versionNo",
             v.status, v.company_id as "companyId"
        from form_template_versions v
        join form_templates t on t.id = v.template_id
       where t.entity_type = ${entityType} and v.status = 'published'
       order by t.company_id nulls last
       limit 1
    `);
    return result.rows[0];
  }

  async findVersion(tx: TxScope, versionId: string): Promise<VersionRow | undefined> {
    const result = await unwrapTxScope(tx).execute<VersionRow>(sql`
      select id, template_id as "templateId", version_no as "versionNo",
             status, company_id as "companyId"
        from form_template_versions where id = ${versionId}
    `);
    return result.rows[0];
  }

  /** The field definitions the compiler turns into a JSON Schema. */
  async fieldsFor(tx: TxScope, versionId: string): Promise<FormTemplateField[]> {
    const result = await unwrapTxScope(tx).execute<FieldRow>(sql`
      select key, data_type as "dataType", is_required as "isRequired", options,
             max_length as "maxLength", min_value as "minValue", max_value as "maxValue"
        from form_template_fields where version_id = ${versionId}
       order by sequence_order
    `);

    return result.rows.map((row) => ({
      key: row.key,
      dataType: row.dataType,
      isRequired: row.isRequired,
      options: toOptions(row.options),
      maxLength: row.maxLength,
      minValue: toNumber(row.minValue),
      maxValue: toNumber(row.maxValue),
    }));
  }

  async createTemplate(
    tx: TxScope,
    companyId: CompanyId,
    entityType: string,
    name: string,
    createdBy: UserId,
  ): Promise<{ id: string }> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      insert into form_templates (company_id, entity_type, name, created_by)
      values (${companyId}, ${entityType}, ${name}, ${createdBy})
      returning id
    `);
    const row = result.rows[0];
    if (row === undefined) throw new Error('template insert returned no row');
    return row;
  }

  /** Next version number for a template, allocated inside the transaction. */
  async createVersion(
    tx: TxScope,
    companyId: CompanyId,
    templateId: string,
  ): Promise<{ id: string }> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      insert into form_template_versions (template_id, company_id, version_no)
      select ${templateId}, ${companyId},
             coalesce(max(version_no), 0) + 1
        from form_template_versions where template_id = ${templateId}
      returning id
    `);
    const row = result.rows[0];
    if (row === undefined) throw new Error('version insert returned no row');
    return row;
  }

  async replaceFields(
    tx: TxScope,
    companyId: CompanyId,
    versionId: string,
    fields: readonly (FormTemplateField & { label: string; sequenceOrder: number })[],
  ): Promise<void> {
    const client = unwrapTxScope(tx);
    await client.execute(sql`delete from form_template_fields where version_id = ${versionId}`);

    for (const field of fields) {
      await client.execute(sql`
        insert into form_template_fields
          (version_id, company_id, key, label, data_type, is_required, options,
           max_length, min_value, max_value, sequence_order)
        values (${versionId}, ${companyId}, ${field.key}, ${field.label}, ${field.dataType},
                ${field.isRequired}, ${JSON.stringify(field.options)}::jsonb,
                ${field.maxLength}, ${field.minValue}, ${field.maxValue},
                ${field.sequenceOrder})
      `);
    }
  }

  /**
   * Archives the currently published version.
   *
   * Runs before the new version is marked published, because
   * `ux_form_versions_published` permits exactly one — doing it the other way
   * round violates the index mid-transaction.
   */
  async archivePublished(tx: TxScope, templateId: string): Promise<void> {
    await unwrapTxScope(tx).execute(sql`
      update form_template_versions set status = 'archived'
       where template_id = ${templateId} and status = 'published'
    `);
  }

  async markPublished(tx: TxScope, versionId: string, publishedBy: UserId): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`
      update form_template_versions
         set status = 'published', published_at = now(), published_by = ${publishedBy}
       where id = ${versionId} and status = 'draft'
    `);
    return result.rowCount ?? 0;
  }
}
