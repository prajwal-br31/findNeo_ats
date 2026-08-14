import { Type, type Static } from '@sinclair/typebox';

/** TypeBox schemas for jobs, forms and pipeline (T-041 … T-050). */

const FieldDataType = Type.Unsafe<string>({
  type: 'string',
  enum: ['text', 'long_text', 'number', 'date', 'boolean', 'select', 'multi_select'],
});

export const FieldDefinition = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 49, pattern: '^[a-z][a-z0-9_]{0,48}$' }),
    label: Type.String({ minLength: 1, maxLength: 200 }),
    dataType: FieldDataType,
    isRequired: Type.Boolean(),
    options: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 100 }),
    maxLength: Type.Union([Type.Integer({ minimum: 1, maximum: 2000 }), Type.Null()]),
    minValue: Type.Union([Type.Number(), Type.Null()]),
    maxValue: Type.Union([Type.Number(), Type.Null()]),
    sequenceOrder: Type.Integer({ minimum: 0, maximum: 1000 }),
  },
  { additionalProperties: false },
);

export const ReplaceFieldsBody = Type.Object(
  { fields: Type.Array(FieldDefinition, { maxItems: 60 }) },
  { additionalProperties: false },
);
export type ReplaceFieldsBody = Static<typeof ReplaceFieldsBody>;

export const CreateTemplateBody = Type.Object(
  {
    entityType: Type.Unsafe<'job' | 'application'>({
      type: 'string',
      enum: ['job', 'application'],
    }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);
export type CreateTemplateBody = Static<typeof CreateTemplateBody>;

export const ActiveFormResponse = Type.Object(
  {
    versionId: Type.String({ format: 'uuid' }),
    versionNo: Type.Integer(),
    fields: Type.Array(Type.Any()),
  },
  { additionalProperties: false },
);

/* ------------------------------------------------------------------- jobs -- */

export const CreateJobBody = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 300 }),
    departmentId: Type.String({ format: 'uuid' }),
    description: Type.Optional(Type.String({ maxLength: 20_000 })),
    employmentType: Type.Optional(
      Type.Unsafe<string>({
        type: 'string',
        enum: ['full_time', 'part_time', 'contract', 'internship', 'temporary'],
      }),
    ),
    workMode: Type.Optional(
      Type.Unsafe<string>({ type: 'string', enum: ['onsite', 'hybrid', 'remote'] }),
    ),
    countryCode: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
    city: Type.Optional(Type.String({ maxLength: 200 })),
    headcount: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
    salaryMin: Type.Optional(Type.Number({ minimum: 0 })),
    salaryMax: Type.Optional(Type.Number({ minimum: 0 })),
    salaryCurrency: Type.Optional(Type.String({ minLength: 3, maxLength: 3 })),
    pipelineTemplateId: Type.Optional(Type.String({ format: 'uuid' })),
    skills: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 120 }),
            weight: Type.Integer({ minimum: 1, maximum: 10 }),
            isMandatory: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
        { maxItems: 50 },
      ),
    ),
    /* Validated against the pinned form version's compiled schema, not here.
       `Type.Any()` because the shape is defined per company at runtime. */
    customFields: Type.Optional(Type.Any()),
  },
  { additionalProperties: false },
);
export type CreateJobBody = Static<typeof CreateJobBody>;

export const UpdateJobBody = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 20_000 }), Type.Null()])),
    customFields: Type.Optional(Type.Any()),
  },
  { additionalProperties: false },
);
export type UpdateJobBody = Static<typeof UpdateJobBody>;

export const SetConfidentialBody = Type.Object(
  { confidential: Type.Boolean() },
  { additionalProperties: false },
);
export type SetConfidentialBody = Static<typeof SetConfidentialBody>;

export const JobResponse = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    title: Type.String(),
    departmentId: Type.String({ format: 'uuid' }),
    status: Type.String(),
    confidential: Type.Boolean(),
    employmentType: Type.Union([Type.String(), Type.Null()]),
    workMode: Type.Union([Type.String(), Type.Null()]),
    salaryMin: Type.Union([Type.Number(), Type.Null()]),
    salaryMax: Type.Union([Type.Number(), Type.Null()]),
    salaryCurrency: Type.Union([Type.String(), Type.Null()]),
    publishToCareerSite: Type.Boolean(),
    publishedAt: Type.Union([Type.String(), Type.Null()]),
    formTemplateVersionId: Type.String({ format: 'uuid' }),
    customFields: Type.Any(),
    createdAt: Type.String(),
    /** Present only when something was withheld (07 §8). */
    _masked: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const JobListResponse = Type.Object(
  { data: Type.Array(JobResponse) },
  { additionalProperties: false },
);

/* --------------------------------------------------------------- pipeline -- */

export const CreateStageBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    stageType: Type.Unsafe<string>({
      type: 'string',
      enum: ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'],
    }),
    isTerminal: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type CreateStageBody = Static<typeof CreateStageBody>;

export const UpdateStageBody = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 120 }) },
  { additionalProperties: false },
);
export type UpdateStageBody = Static<typeof UpdateStageBody>;

export const ReorderStagesBody = Type.Object(
  { stageIds: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 50 }) },
  { additionalProperties: false },
);
export type ReorderStagesBody = Static<typeof ReorderStagesBody>;

export const StageListResponse = Type.Object(
  {
    data: Type.Array(
      Type.Object(
        {
          id: Type.String({ format: 'uuid' }),
          name: Type.String(),
          sequenceOrder: Type.Integer(),
          stageType: Type.String(),
          isTerminal: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const AddTeamMemberBody = Type.Object(
  {
    userId: Type.String({ format: 'uuid' }),
    teamRole: Type.Unsafe<string>({
      type: 'string',
      enum: ['hiring_manager', 'recruiter', 'coordinator', 'interviewer'],
    }),
  },
  { additionalProperties: false },
);
export type AddTeamMemberBody = Static<typeof AddTeamMemberBody>;

export const TeamListResponse = Type.Object(
  {
    data: Type.Array(
      Type.Object(
        {
          id: Type.String({ format: 'uuid' }),
          userId: Type.String({ format: 'uuid' }),
          teamRole: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const SkillListResponse = Type.Object(
  { data: Type.Array(Type.Any()) },
  { additionalProperties: false },
);

export const CreatedIdResponse = Type.Object(
  { id: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
