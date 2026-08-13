import { Type, type Static } from '@sinclair/typebox';

/**
 * TypeBox schemas for the identity module (07 §3).
 *
 * `additionalProperties: false` everywhere. An unknown property is a 422, not
 * something to ignore: silently dropping a misspelled field is how a client
 * ships a bug that looks like it works.
 */

/* Reserved at signup because they address the public career site and would
   collide with the platform's own hostnames (08 §3). */
export const RESERVED_SLUGS = ['www', 'api', 'app', 'admin', 'static'] as const;

/** 12 is the floor; there is no upper composition rule (SEC-016, NIST 800-63B). */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

const Email = Type.String({ format: 'email', minLength: 3, maxLength: 254 });

const Password = Type.String({
  minLength: MIN_PASSWORD_LENGTH,
  maxLength: MAX_PASSWORD_LENGTH,
  /* Length, not character classes. Composition rules push people toward
     `Password1!` and buy less entropy than four more characters. The maximum
     exists only to bound argon2's input, not as a policy. */
});

export const SignupBody = Type.Object(
  {
    companyName: Type.String({ minLength: 1, maxLength: 200 }),
    slug: Type.String({ minLength: 2, maxLength: 63, pattern: '^[a-z0-9][a-z0-9-]{1,62}$' }),
    countryCode: Type.String({ minLength: 2, maxLength: 2, pattern: '^[A-Z]{2}$' }),
    fullName: Type.String({ minLength: 1, maxLength: 200 }),
    email: Email,
    password: Password,
  },
  { additionalProperties: false },
);
export type SignupBody = Static<typeof SignupBody>;

/**
 * No session, no tokens. The owner verifies their email and enables MFA before
 * anything is issued (08 §3) — returning a session here would make the
 * verification step advisory.
 */
export const SignupResponse = Type.Object(
  {
    companyId: Type.String({ format: 'uuid' }),
    userId: Type.String({ format: 'uuid' }),
    status: Type.Literal('pending_verification'),
  },
  { additionalProperties: false },
);
export type SignupResponse = Static<typeof SignupResponse>;

export const LoginBody = Type.Object(
  {
    email: Email,
    password: Type.String({ minLength: 1, maxLength: MAX_PASSWORD_LENGTH }),
    /* Deliberately NOT MIN_PASSWORD_LENGTH: rejecting a short password at the
       schema gives a distinguishable, much faster response than a wrong one,
       which is a free oracle for password length. Login validates that a
       string arrived, and nothing about its shape. */
  },
  { additionalProperties: false },
);
export type LoginBody = Static<typeof LoginBody>;

export const LoginResponse = Type.Object(
  {
    accessToken: Type.String(),
    expiresAt: Type.String({ format: 'date-time' }),
    user: Type.Object(
      {
        id: Type.String({ format: 'uuid' }),
        email: Type.String(),
        fullName: Type.String(),
        companyId: Type.String({ format: 'uuid' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type LoginResponse = Static<typeof LoginResponse>;

/**
 * Verification carries the ids alongside the token.
 *
 * The token alone would be enough to find the row if verification tokens lived
 * in their own globally-indexed table. They live in tenant-scoped `settings`
 * until that table lands, and a tenant-scoped read needs a tenant to bind —
 * so the company id travels with the link. It grants nothing on its own: the
 * token is still a 256-bit secret compared by hash.
 */
export const VerifyEmailBody = Type.Object(
  {
    companyId: Type.String({ format: 'uuid' }),
    userId: Type.String({ format: 'uuid' }),
    token: Type.String({ minLength: 16, maxLength: 200 }),
  },
  { additionalProperties: false },
);
export type VerifyEmailBody = Static<typeof VerifyEmailBody>;
