import { sql } from 'drizzle-orm';

import { unwrapTxScope } from '../../../platform/db/tx-scope.js';
import type { TxScope } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';

/** Pipeline templates, the per-job copy, hiring team and skills (T-046/47/48). */

export interface StageRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly sequenceOrder: number;
  readonly stageType: string;
  readonly isTerminal: boolean;
}

export interface TeamMemberRow extends Record<string, unknown> {
  readonly id: string;
  readonly userId: string;
  readonly teamRole: string;
}

export interface SkillRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly companyId: string | null;
}

/** Shifted out of range during a reorder. See `reorderStages`. */
const REORDER_OFFSET = 1000;

export class PipelineRepository {
  /* ------------------------------------------------------------ templates -- */

  async listTemplates(tx: TxScope): Promise<{ id: string; name: string }[]> {
    const result = await unwrapTxScope(tx).execute<{ id: string; name: string }>(sql`
      select id, name from pipeline_templates
       where status = 'active' order by company_id nulls first, name
    `);
    return result.rows;
  }

  /** The default template: the company's own if it has one, else platform. */
  async defaultTemplateId(tx: TxScope): Promise<string | undefined> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      select id from pipeline_templates
       where status = 'active'
       order by company_id nulls last
       limit 1
    `);
    return result.rows[0]?.id;
  }

  /* ----------------------------------------------------------- job stages -- */

  /**
   * Copies a template's stages onto a job. A one-time copy, taken at creation.
   *
   * This is the point of the template decision: editing the template
   * afterwards must never alter a live job's pipeline, and it cannot, because
   * nothing links them after this INSERT.
   */
  async copyStagesFromTemplate(
    tx: TxScope,
    companyId: CompanyId,
    jobId: string,
    templateId: string,
  ): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`
      insert into job_pipeline_stages
        (company_id, job_id, name, sequence_order, stage_type, is_terminal)
      select ${companyId}, ${jobId}, s.name, s.sequence_order, s.stage_type, s.is_terminal
        from pipeline_template_stages s
       where s.template_id = ${templateId}
       order by s.sequence_order
    `);
    return result.rowCount ?? 0;
  }

  async listStages(tx: TxScope, jobId: string): Promise<StageRow[]> {
    const result = await unwrapTxScope(tx).execute<StageRow>(sql`
      select id, name, sequence_order as "sequenceOrder", stage_type as "stageType",
             is_terminal as "isTerminal"
        from job_pipeline_stages where job_id = ${jobId} order by sequence_order
    `);
    return result.rows;
  }

  async addStage(
    tx: TxScope,
    companyId: CompanyId,
    jobId: string,
    input: { name: string; stageType: string; isTerminal: boolean },
  ): Promise<{ id: string }> {
    const result = await unwrapTxScope(tx).execute<{ id: string }>(sql`
      insert into job_pipeline_stages
        (company_id, job_id, name, sequence_order, stage_type, is_terminal)
      select ${companyId}, ${jobId}, ${input.name},
             coalesce(max(sequence_order), 0) + 1, ${input.stageType}, ${input.isTerminal}
        from job_pipeline_stages where job_id = ${jobId}
      returning id
    `);
    const row = result.rows[0];
    if (row === undefined) throw new Error('stage insert returned no row');
    return row;
  }

  async renameStage(tx: TxScope, stageId: string, name: string): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`
      update job_pipeline_stages set name = ${name} where id = ${stageId}
    `);
    return result.rowCount ?? 0;
  }

  async deleteStage(tx: TxScope, stageId: string): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`
      delete from job_pipeline_stages where id = ${stageId}
    `);
    return result.rowCount ?? 0;
  }

  /**
   * Reorders stages with the two-phase shift (08-lld-jobs §4).
   *
   * `sequence_order` is unique per job, so assigning targets directly collides
   * with whatever currently holds them — mid-transaction, on a constraint that
   * is immediate. Phase one moves every row far out of range; phase two
   * assigns the targets into the vacated space.
   *
   * The `SELECT ... FOR UPDATE` on the job row serialises concurrent reorders.
   * Without it two callers interleave their phases and one wins a partial
   * ordering.
   *
   * The alternative — a DEFERRABLE constraint — also works, and is
   * deliberately not used: two mechanisms for one problem produce intermittent
   * failures nobody can reproduce.
   */
  async reorderStages(
    tx: TxScope,
    jobId: string,
    orderedStageIds: readonly string[],
  ): Promise<void> {
    const client = unwrapTxScope(tx);

    await client.execute(sql`select 1 from jobs where id = ${jobId} for update`);

    await client.execute(sql`
      update job_pipeline_stages set sequence_order = sequence_order + ${REORDER_OFFSET}
       where job_id = ${jobId}
    `);

    let position = 1;
    for (const stageId of orderedStageIds) {
      await client.execute(sql`
        update job_pipeline_stages set sequence_order = ${position}
         where id = ${stageId} and job_id = ${jobId}
      `);
      position += 1;
    }
  }

  /* --------------------------------------------------------- hiring team -- */

  async listTeam(tx: TxScope, jobId: string): Promise<TeamMemberRow[]> {
    const result = await unwrapTxScope(tx).execute<TeamMemberRow>(sql`
      select id, user_id as "userId", team_role as "teamRole"
        from job_hiring_team where job_id = ${jobId} order by added_at
    `);
    return result.rows;
  }

  async addTeamMember(
    tx: TxScope,
    companyId: CompanyId,
    jobId: string,
    userId: UserId,
    teamRole: string,
    addedBy: UserId,
  ): Promise<void> {
    /* The composite FKs reject a user or job from another tenant (BR-008).
       Both rows would live legitimately in the caller's own tenant, so RLS
       cannot catch the mismatch — the constraint is the only control. */
    await unwrapTxScope(tx).execute(sql`
      insert into job_hiring_team (company_id, job_id, user_id, team_role, added_by)
      values (${companyId}, ${jobId}, ${userId}, ${teamRole}, ${addedBy})
      on conflict (job_id, user_id, team_role) do nothing
    `);
  }

  async removeTeamMember(tx: TxScope, jobId: string, userId: UserId): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`
      delete from job_hiring_team where job_id = ${jobId} and user_id = ${userId}
    `);
    return result.rowCount ?? 0;
  }

  /* --------------------------------------------------------------- skills -- */

  async listSkills(tx: TxScope): Promise<SkillRow[]> {
    const result = await unwrapTxScope(tx).execute<SkillRow>(sql`
      select id, name, slug, company_id as "companyId"
        from skills order by company_id nulls first, name limit 500
    `);
    return result.rows;
  }

  /**
   * Finds a skill by slug, or creates it in the company's own scope.
   *
   * Unknown skills are auto-created on first use (06 §6) — the catalog exists
   * so the ranker matches "React" against "React", not so a recruiter is
   * blocked from typing one it has not seen.
   */
  async findOrCreateSkill(
    tx: TxScope,
    companyId: CompanyId,
    name: string,
    slug: string,
  ): Promise<string> {
    const client = unwrapTxScope(tx);

    const existing = await client.execute<{ id: string }>(sql`
      select id from skills
       where slug = ${slug} and (company_id is null or company_id = ${companyId})
       order by company_id nulls last
       limit 1
    `);
    const found = existing.rows[0]?.id;
    if (found !== undefined) return found;

    const created = await client.execute<{ id: string }>(sql`
      insert into skills (company_id, name, slug) values (${companyId}, ${name}, ${slug})
      returning id
    `);
    const id = created.rows[0]?.id;
    if (id === undefined) throw new Error('skill insert returned no row');
    return id;
  }

  async addJobSkill(
    tx: TxScope,
    companyId: CompanyId,
    jobId: string,
    skillId: string,
    input: { minYears: number | null; isMandatory: boolean; weight: number },
  ): Promise<void> {
    await unwrapTxScope(tx).execute(sql`
      insert into job_skills (company_id, job_id, skill_id, min_years, is_mandatory, weight)
      values (${companyId}, ${jobId}, ${skillId}, ${input.minYears}, ${input.isMandatory},
              ${input.weight})
      on conflict (job_id, skill_id) do nothing
    `);
  }

  async removeJobSkill(tx: TxScope, jobId: string, skillId: string): Promise<number> {
    const result = await unwrapTxScope(tx).execute(sql`
      delete from job_skills where job_id = ${jobId} and skill_id = ${skillId}
    `);
    return result.rowCount ?? 0;
  }

  async listJobSkills(tx: TxScope, jobId: string): Promise<Record<string, unknown>[]> {
    const result = await unwrapTxScope(tx).execute(sql`
      select js.skill_id as "skillId", s.name, s.slug, js.min_years as "minYears",
             js.is_mandatory as "isMandatory", js.weight
        from job_skills js join skills s on s.id = js.skill_id
       where js.job_id = ${jobId} order by js.weight desc, s.name
    `);
    return result.rows;
  }
}
