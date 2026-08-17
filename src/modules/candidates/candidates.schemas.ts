import { Type, type Static } from '@sinclair/typebox';

/** Request and response schemas for the candidates module (07 §2). */

const Nullable = <T extends ReturnType<typeof Type.String>>(schema: T) =>
  Type.Optional(Type.Union([schema, Type.Null()]));

export const CreateCandidateBody = Type.Object(
  {
    fullName: Type.String({ minLength: 1, maxLength: 200 }),
    email: Nullable(Type.String({ format: 'email', maxLength: 254 })),
    phone: Nullable(Type.String({ maxLength: 40 })),
    currentTitle: Nullable(Type.String({ maxLength: 200 })),
    currentEmployer: Nullable(Type.String({ maxLength: 200 })),
    totalExperienceYears: Type.Optional(
      Type.Union([Type.Number({ minimum: 0, maximum: 70 }), Type.Null()]),
    ),
    currentCtc: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
    ctcCurrency: Nullable(Type.String({ minLength: 3, maxLength: 3 })),
    educationLevel: Nullable(Type.String({ maxLength: 100 })),
    locationCity: Nullable(Type.String({ maxLength: 120 })),
    locationCountry: Nullable(Type.String({ minLength: 2, maxLength: 2 })),
    linkedinUrl: Nullable(Type.String({ maxLength: 400 })),
    source: Type.Optional(
      Type.Unsafe<string>({
        type: 'string',
        enum: ['self_apply', 'internal_add', 'agency', 'pool_import', 'referral'],
      }),
    ),
  },
  { additionalProperties: false },
);
export type CreateCandidateBody = Static<typeof CreateCandidateBody>;

/** Every field optional; only what is present is written. */
export const UpdateCandidateBody = Type.Object(
  {
    fullName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    phone: Nullable(Type.String({ maxLength: 40 })),
    currentTitle: Nullable(Type.String({ maxLength: 200 })),
    currentEmployer: Nullable(Type.String({ maxLength: 200 })),
    totalExperienceYears: Type.Optional(
      Type.Union([Type.Number({ minimum: 0, maximum: 70 }), Type.Null()]),
    ),
    currentCtc: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
    ctcCurrency: Nullable(Type.String({ minLength: 3, maxLength: 3 })),
    educationLevel: Nullable(Type.String({ maxLength: 100 })),
    locationCity: Nullable(Type.String({ maxLength: 120 })),
    locationCountry: Nullable(Type.String({ minLength: 2, maxLength: 2 })),
    linkedinUrl: Nullable(Type.String({ maxLength: 400 })),
  },
  { additionalProperties: false },
);
export type UpdateCandidateBody = Static<typeof UpdateCandidateBody>;

export const CandidateResponse = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    fullName: Type.String(),
    email: Type.Union([Type.String(), Type.Null()]),
    phone: Type.Union([Type.String(), Type.Null()]),
    currentTitle: Type.Union([Type.String(), Type.Null()]),
    currentEmployer: Type.Union([Type.String(), Type.Null()]),
    totalExperienceYears: Type.Union([Type.Number(), Type.Null()]),
    currentCtc: Type.Union([Type.Number(), Type.Null()]),
    ctcCurrency: Type.Union([Type.String(), Type.Null()]),
    educationLevel: Type.Union([Type.String(), Type.Null()]),
    locationCity: Type.Union([Type.String(), Type.Null()]),
    locationCountry: Type.Union([Type.String(), Type.Null()]),
    linkedinUrl: Type.Union([Type.String(), Type.Null()]),
    source: Type.String(),
    currentResumeId: Type.Union([Type.String(), Type.Null()]),
    consentStatus: Type.String(),
    createdAt: Type.String(),
    /** Present only when something was withheld (07 §8). */
    _masked: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const DuplicateMatch = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    fullName: Type.String(),
    email: Type.Union([Type.String(), Type.Null()]),
    matchedOn: Type.String(),
    similarity: Type.Number(),
  },
  { additionalProperties: false },
);

/* -------------------------------------------------------------- pool -- */

export const AddToPoolBody = Type.Object(
  {
    candidateId: Type.String({ format: 'uuid' }),
    source: Nullable(Type.String({ maxLength: 100 })),
    notes: Nullable(Type.String({ maxLength: 2000 })),
    tags: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 20 })),
  },
  { additionalProperties: false },
);
export type AddToPoolBody = Static<typeof AddToPoolBody>;

export const PoolStatusBody = Type.Object(
  {
    status: Type.Unsafe<string>({ type: 'string', enum: ['active', 'archived', 'placed'] }),
  },
  { additionalProperties: false },
);
export type PoolStatusBody = Static<typeof PoolStatusBody>;

/* ------------------------------------------------------ applications -- */

export const SubmitApplicationBody = Type.Object(
  {
    jobId: Type.String({ format: 'uuid' }),
    candidateId: Type.String({ format: 'uuid' }),
    source: Type.Optional(
      Type.Unsafe<string>({
        type: 'string',
        enum: ['career_site', 'internal_add', 'agency', 'pool_conversion', 'referral'],
      }),
    ),
    /* Stated per role, not read from the profile — the same person quotes
       different numbers for different jobs, and that is correct (BR-055). */
    expectedCtc: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
    noticePeriodDays: Type.Optional(
      Type.Union([Type.Integer({ minimum: 0, maximum: 365 }), Type.Null()]),
    ),
    customFields: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type SubmitApplicationBody = Static<typeof SubmitApplicationBody>;

export const TransferApplicationBody = Type.Object(
  { targetJobId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
export type TransferApplicationBody = Static<typeof TransferApplicationBody>;

export const DecisionBody = Type.Object(
  {
    toStageId: Type.Optional(Type.String({ format: 'uuid' })),
    reasonKeys: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 10 })),
    notes: Nullable(Type.String({ maxLength: 4000 })),
  },
  { additionalProperties: false },
);
export type DecisionBody = Static<typeof DecisionBody>;

export const ApplicationResponse = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    jobId: Type.String({ format: 'uuid' }),
    jobTitle: Type.Union([Type.String(), Type.Null()]),
    candidateId: Type.String({ format: 'uuid' }),
    currentStageId: Type.Union([Type.String(), Type.Null()]),
    currentStageName: Type.Union([Type.String(), Type.Null()]),
    status: Type.String(),
    source: Type.String(),
    ownerUserId: Type.Union([Type.String(), Type.Null()]),
    formTemplateVersionId: Type.String({ format: 'uuid' }),
    customFields: Type.Any(),
    appliedAt: Type.String(),
    closedAt: Type.Union([Type.String(), Type.Null()]),
    transferredFromId: Type.Union([Type.String(), Type.Null()]),
    snapshotFullName: Type.String(),
    snapshotEmail: Type.Union([Type.String(), Type.Null()]),
    snapshotPhone: Type.Union([Type.String(), Type.Null()]),
    snapshotCurrentTitle: Type.Union([Type.String(), Type.Null()]),
    snapshotCurrentEmployer: Type.Union([Type.String(), Type.Null()]),
    snapshotExperienceYears: Type.Union([Type.Number(), Type.Null()]),
    snapshotCurrentCtc: Type.Union([Type.Number(), Type.Null()]),
    snapshotExpectedCtc: Type.Union([Type.Number(), Type.Null()]),
    snapshotNoticePeriodDays: Type.Union([Type.Integer(), Type.Null()]),
    snapshotCtcCurrency: Type.Union([Type.String(), Type.Null()]),
    snapshotLocation: Type.Union([Type.String(), Type.Null()]),
    snapshotEducationLevel: Type.Union([Type.String(), Type.Null()]),
    _masked: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const CreatedIdResponse = Type.Object(
  { id: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
