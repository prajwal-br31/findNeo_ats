import { Type, type Static } from '@sinclair/typebox';

/** Schemas for departments, roles and the platform surface (T-031/32/33). */

/* ------------------------------------------------------------ departments -- */

export const CreateDepartmentBody = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 120 }) },
  { additionalProperties: false },
);
export type CreateDepartmentBody = Static<typeof CreateDepartmentBody>;

export const UpdateDepartmentBody = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 120 }) },
  { additionalProperties: false },
);
export type UpdateDepartmentBody = Static<typeof UpdateDepartmentBody>;

export const DepartmentResponse = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: Type.String(),
    headUserId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    status: Type.String(),
    memberCount: Type.Integer(),
  },
  { additionalProperties: false },
);

export const DepartmentListResponse = Type.Object(
  { data: Type.Array(DepartmentResponse) },
  { additionalProperties: false },
);

export const AddMemberBody = Type.Object(
  { userId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
export type AddMemberBody = Static<typeof AddMemberBody>;

/* ------------------------------------------------------------------ roles -- */

export const CreateRoleBody = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9_]+$' }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    scope: Type.Unsafe<'company' | 'department' | 'job'>({
      type: 'string',
      enum: ['company', 'department', 'job'],
    }),
    /* No `platform` scope. A company cannot mint a platform-scoped role, and
       leaving it out of the enum is a cheaper guarantee than checking for it. */
    permissionKeys: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 200 }),
  },
  { additionalProperties: false },
);
export type CreateRoleBody = Static<typeof CreateRoleBody>;

export const UpdateRoleBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    permissionKeys: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 200 }),
    ),
  },
  { additionalProperties: false },
);
export type UpdateRoleBody = Static<typeof UpdateRoleBody>;

export const RoleResponse = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    key: Type.String(),
    name: Type.String(),
    scope: Type.String(),
    isEditable: Type.Boolean(),
    /** null marks a platform default, shared across every company. */
    companyId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const RoleListResponse = Type.Object(
  { data: Type.Array(RoleResponse) },
  { additionalProperties: false },
);

export const PermissionListResponse = Type.Object(
  {
    data: Type.Array(
      Type.Object({ key: Type.String(), category: Type.String() }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);

export const AssignRoleBody = Type.Object(
  {
    roleId: Type.String({ format: 'uuid' }),
    /** null or absent = company-wide. */
    departmentId: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { additionalProperties: false },
);
export type AssignRoleBody = Static<typeof AssignRoleBody>;

export const AssignmentResponse = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    roleId: Type.String({ format: 'uuid' }),
    roleKey: Type.String(),
    departmentId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);

export const AssignmentListResponse = Type.Object(
  { data: Type.Array(AssignmentResponse) },
  { additionalProperties: false },
);

export const CreatedIdResponse = Type.Object(
  { id: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

/* --------------------------------------------------------------- platform -- */

export const CompanySummaryResponse = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: Type.String(),
    slug: Type.String(),
    status: Type.String(),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);

export const CompanyListResponse = Type.Object(
  { data: Type.Array(CompanySummaryResponse) },
  { additionalProperties: false },
);

export const ImpersonateBody = Type.Object(
  {
    /* Required, and long enough to be a sentence. Mirrored by a CHECK on the
       column, so nothing can write a grant around this schema (BR-006). */
    reason: Type.String({ minLength: 10, maxLength: 500 }),
    minutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 240 })),
  },
  { additionalProperties: false },
);
export type ImpersonateBody = Static<typeof ImpersonateBody>;

export const ImpersonateResponse = Type.Object(
  {
    grantId: Type.String({ format: 'uuid' }),
    expiresAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
