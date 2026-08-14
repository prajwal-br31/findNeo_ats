import { unsafeCompanyId, unsafeUserId } from '../../shared/types/ids.js';

import type { InvitationsService } from './application/invitations.service.js';
import type { AcceptInvitationBody, CreateInvitationBody } from './invitations.schemas.js';

/** Invitations controller (ER-002). Validates, delegates, shapes. */

export interface InvitationView {
  readonly id: string;
  readonly email: string;
  readonly roleKey: string;
  readonly departmentId: string | null;
  readonly status: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class InvitationsController {
  readonly #service: InvitationsService;

  constructor(service: InvitationsService) {
    this.#service = service;
  }

  async create(
    companyId: string,
    userId: string,
    body: CreateInvitationBody,
  ): Promise<{ id: string }> {
    return this.#service.create(unsafeCompanyId(companyId), unsafeUserId(userId), {
      email: body.email,
      roleKey: body.roleKey,
      departmentId: body.departmentId ?? null,
    });
  }

  async list(companyId: string): Promise<InvitationView[]> {
    const rows = await this.#service.list(unsafeCompanyId(companyId));
    /* Mapped explicitly rather than spread (ER-025): `token_hash` is on the
       row type's neighbours, and an allowlist is what keeps it from ever
       reaching a response by accident. */
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      roleKey: row.roleKey,
      departmentId: row.departmentId,
      status: row.status,
      expiresAt: toIso(row.expiresAt),
      createdAt: toIso(row.createdAt),
    }));
  }

  async revoke(companyId: string, id: string): Promise<void> {
    await this.#service.revoke(unsafeCompanyId(companyId), id);
  }

  async resend(companyId: string, id: string): Promise<void> {
    await this.#service.resend(unsafeCompanyId(companyId), id);
  }

  async preview(token: string): Promise<{ companyName: string }> {
    return this.#service.preview(token);
  }

  async accept(
    token: string,
    body: AcceptInvitationBody,
  ): Promise<{ userId: string; companyId: string }> {
    return this.#service.accept({
      token,
      fullName: body.fullName,
      password: body.password,
    });
  }
}
