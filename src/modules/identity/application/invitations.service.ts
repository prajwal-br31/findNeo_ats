import { createHash, randomBytes } from 'node:crypto';

import { AppError, conflict, notFound } from '../../../shared/errors/app-error.js';
import type { ClockPort } from '../../../shared/ports/clock.js';
import type { MailPort } from '../../../shared/ports/mail.js';
import type { PasswordHasherPort } from '../../../shared/ports/password-hasher.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import {
  unsafeCompanyId,
  unsafeUserId,
  type CompanyId,
  type UserId,
} from '../../../shared/types/ids.js';
import type { IdentityRepository } from '../infrastructure/identity.repository.js';
import type {
  InvitationRow,
  InvitationsRepository,
} from '../infrastructure/invitations.repository.js';

/**
 * Invitations (T-030, 08 §2, §5, §6).
 *
 * Accept is one transaction — user, role assignment and invitation status
 * together (08 §5). Split, a crash between them leaves an accepted invitation
 * with no user, or a user with no role and a token already spent.
 */

export const INVITATION_TTL_DAYS = 7;

export interface CreateInvitationInput {
  readonly email: string;
  readonly roleKey: string;
  readonly departmentId: string | null;
}

export interface AcceptInvitationInput {
  readonly token: string;
  readonly fullName: string;
  readonly password: string;
}

export interface InvitationPreview {
  /** Company name only. No inviter, no email, no role detail (08 §2). */
  readonly companyName: string;
}

export interface InvitationsServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly invitations: InvitationsRepository;
  readonly identity: IdentityRepository;
  readonly hasher: PasswordHasherPort;
  readonly mail: MailPort;
  readonly clock: ClockPort;
  /** Base URL the accept link points at. */
  readonly appBaseUrl: string;
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505' && candidate.constraint === constraint) return true;
    current = candidate.cause;
  }
  return false;
}

export class InvitationsService {
  readonly #deps: InvitationsServiceDeps;

  constructor(deps: InvitationsServiceDeps) {
    this.#deps = deps;
  }

  async create(
    companyId: CompanyId,
    invitedBy: UserId,
    input: CreateInvitationInput,
  ): Promise<{ id: string }> {
    const { uow, invitations, clock } = this.#deps;
    const token = newToken();
    const expiresAt = new Date(clock.now().getTime() + INVITATION_TTL_DAYS * 86_400_000);

    const created = await uow.withTenant(companyId, async (tx: TxScope) => {
      const roleId = await invitations.findRoleIdByKey(tx, input.roleKey);
      /* 404 rather than 422: from outside, an unknown role and a role in
         another tenant must be indistinguishable (SEC-026). */
      if (roleId === undefined) throw notFound('Role not found.');

      try {
        const row = await invitations.create(tx, {
          companyId,
          email: input.email,
          roleId,
          departmentId: input.departmentId,
          invitedBy,
          tokenHash: hashToken(token),
          expiresAt,
        });
        const companyName = await invitations.companyName(tx, companyId);
        return { id: row.id, companyName };
      } catch (error) {
        /* The partial unique index allows one pending invitation per address
           per company. A duplicate is a 409 (08 §6), not a second email. */
        if (isUniqueViolation(error, 'ux_invitations_pending_email')) {
          throw conflict('ERR_DUPLICATE', 'An invitation to this address is already pending.');
        }
        throw error;
      }
    });

    await this.#sendInvitation(input.email, created.companyName, token, expiresAt);
    return { id: created.id };
  }

  async list(companyId: CompanyId): Promise<InvitationRow[]> {
    const { uow, invitations } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) => invitations.list(tx));
  }

  async revoke(companyId: CompanyId, id: string): Promise<void> {
    const { uow, invitations } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const existing = await invitations.findById(tx, id);
      /* RLS already hid another tenant's row, so `undefined` covers both "no
         such invitation" and "not yours" — which is the required answer for
         the second case anyway (SEC-026). */
      if (existing === undefined) throw notFound('Invitation not found.');

      const revoked = await invitations.markRevoked(tx, id);
      if (revoked !== 1) {
        throw conflict('ERR_CONFLICT', 'Only a pending invitation can be revoked.');
      }
    });
  }

  /** Issues a fresh token, which invalidates the previous link. */
  async resend(companyId: CompanyId, id: string): Promise<void> {
    const { uow, invitations, clock } = this.#deps;
    const token = newToken();
    const expiresAt = new Date(clock.now().getTime() + INVITATION_TTL_DAYS * 86_400_000);

    const target = await uow.withTenant(companyId, async (tx: TxScope) => {
      const existing = await invitations.findById(tx, id);
      if (existing === undefined) throw notFound('Invitation not found.');

      const replaced = await invitations.replaceToken(tx, id, hashToken(token), expiresAt);
      if (replaced !== 1) {
        throw conflict('ERR_CONFLICT', 'Only a pending invitation can be resent.');
      }

      const companyName = await invitations.companyName(tx, companyId);
      return { email: existing.email, companyName };
    });

    await this.#sendInvitation(target.email, target.companyName, token, expiresAt);
  }

  /**
   * Preview, unauthenticated. Company name and nothing else (08 §2).
   *
   * A wrong, expired, revoked or already-accepted token all produce the same
   * 404. Distinguishing them turns the endpoint into an oracle for which
   * tokens once existed.
   */
  async preview(token: string): Promise<InvitationPreview> {
    const { uow, invitations, clock } = this.#deps;

    return uow.withoutTenant(async (tx: TxScope) => {
      const found = await invitations.findByTokenHash(tx, hashToken(token));
      if (found === undefined) throw notFound('Invitation not found.');
      if (found.status !== 'pending') throw notFound('Invitation not found.');
      if (new Date(found.expiresAt).getTime() <= clock.now().getTime()) {
        throw notFound('Invitation not found.');
      }
      return { companyName: found.companyName };
    });
  }

  /**
   * Accepts an invitation: user, role assignment and status in one
   * transaction (08 §5).
   *
   * Starts untenanted because the token is the only thing identifying the
   * tenant, then binds to the company the invitation belongs to. The invitee
   * never supplies a company id, so there is nothing to forge.
   */
  async accept(input: AcceptInvitationInput): Promise<{ userId: UserId; companyId: CompanyId }> {
    const { uow, invitations, identity, hasher, clock } = this.#deps;

    const passwordHash = await hasher.hash(input.password);

    return uow.withNewTenant(async (tx: TxScope, bind) => {
      const found = await invitations.findByTokenHash(tx, hashToken(input.token));
      if (found === undefined || found.status !== 'pending') {
        throw notFound('Invitation not found.');
      }
      if (new Date(found.expiresAt).getTime() <= clock.now().getTime()) {
        throw notFound('Invitation not found.');
      }

      const companyId = unsafeCompanyId(found.companyId);
      await bind(companyId);

      /* Consumed first. The partial `status = 'pending'` predicate means two
         simultaneous accepts of one token both read it as valid but only one
         updates a row — and the loser stops here rather than creating a
         second user. */
      const consumed = await invitations.markAccepted(tx, found.id);
      if (consumed !== 1) throw notFound('Invitation not found.');

      const user = await identity.insertUser(tx, {
        companyId,
        email: found.email,
        fullName: input.fullName,
        passwordHash,
      });
      const userId = unsafeUserId(user.id);

      /* The invitee's address was proven by receiving the token, so there is
         no second verification round. */
      await identity.activateVerifiedUser(tx, userId);
      await identity.assignRoleById(tx, companyId, userId, found.roleId);

      if (found.departmentId !== null) {
        await identity.addToDepartment(tx, companyId, userId, found.departmentId);
      }

      return { userId, companyId };
    });
  }

  /**
   * Sent outside the transaction, deliberately.
   *
   * SMTP inside a database transaction holds a connection open for the
   * round-trip to the mail server, and a slow relay becomes a pool outage. The
   * trade is a committed invitation whose email failed to send — which resend
   * exists to fix, and which is strictly better than the reverse.
   */
  async #sendInvitation(
    email: string,
    companyName: string,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    const { mail, appBaseUrl } = this.#deps;

    try {
      await mail.send({
        to: email,
        templateId: 'invitation.created',
        variables: {
          companyName,
          acceptUrl: `${appBaseUrl}/invitations/${token}/accept`,
          expiresAt: expiresAt.toISOString().slice(0, 10),
        },
      });
    } catch (error) {
      /* The invitation exists; only delivery failed. Surfacing the SMTP
         failure as-is would leak the recipient into an error body, so the
         caller gets a code and the operator gets the adapter's log line. */
      throw new AppError('ERR_INTERNAL', {
        detail: 'The invitation was created but the email could not be sent.',
        cause: error,
      });
    }
  }
}
