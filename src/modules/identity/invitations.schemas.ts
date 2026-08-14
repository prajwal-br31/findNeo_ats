import { Type, type Static } from '@sinclair/typebox';

/** TypeBox schemas for invitations (T-030, 08 §2). */

export const CreateInvitationBody = Type.Object(
  {
    email: Type.String({ format: 'email', minLength: 3, maxLength: 254 }),
    /* By key, not by id. A caller that names `hiring_manager` cannot be handed
       another tenant's role id by mistake, and the key is what the role matrix
       in 04 §3 is written in. */
    roleKey: Type.String({ minLength: 1, maxLength: 64 }),
    departmentId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { additionalProperties: false },
);
export type CreateInvitationBody = Static<typeof CreateInvitationBody>;

export const InvitationResponse = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    email: Type.String(),
    roleKey: Type.String(),
    departmentId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    status: Type.String(),
    expiresAt: Type.String(),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);

export const InvitationListResponse = Type.Object(
  { data: Type.Array(InvitationResponse) },
  { additionalProperties: false },
);

export const CreatedInvitationResponse = Type.Object(
  { id: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

/** Company name only. No inviter, no role, no email (08 §2). */
export const InvitationPreviewResponse = Type.Object(
  { companyName: Type.String() },
  { additionalProperties: false },
);

export const AcceptInvitationBody = Type.Object(
  {
    fullName: Type.String({ minLength: 1, maxLength: 200 }),
    password: Type.String({ minLength: 12, maxLength: 200 }),
  },
  { additionalProperties: false },
);
export type AcceptInvitationBody = Static<typeof AcceptInvitationBody>;

export const AcceptInvitationResponse = Type.Object(
  {
    userId: Type.String({ format: 'uuid' }),
    companyId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false },
);
