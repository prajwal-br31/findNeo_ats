import { unsafeCompanyId, unsafeUserId } from '../../shared/types/ids.js';

import type { DepartmentsService } from './application/departments.service.js';
import type { PlatformService } from './application/platform.service.js';
import type { RolesService } from './application/roles.service.js';
import type {
  AssignRoleBody,
  CreateDepartmentBody,
  CreateRoleBody,
  ImpersonateBody,
  UpdateRoleBody,
} from './access.schemas.js';

/**
 * Departments, roles and the platform surface (ER-002).
 *
 * One controller over three services because the routes share a shape and
 * nothing here decides anything — splitting it would be three files of
 * delegation.
 */

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class AccessController {
  readonly #departments: DepartmentsService;
  readonly #roles: RolesService;
  readonly #platform: PlatformService;

  constructor(departments: DepartmentsService, roles: RolesService, platform: PlatformService) {
    this.#departments = departments;
    this.#roles = roles;
    this.#platform = platform;
  }

  /* ---------------------------------------------------------- departments -- */

  async listDepartments(companyId: string): Promise<unknown[]> {
    const rows = await this.#departments.list(unsafeCompanyId(companyId));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      headUserId: row.headUserId,
      status: row.status,
      memberCount: row.memberCount,
    }));
  }

  async createDepartment(companyId: string, body: CreateDepartmentBody): Promise<{ id: string }> {
    return this.#departments.create(unsafeCompanyId(companyId), body.name);
  }

  async renameDepartment(companyId: string, id: string, name: string): Promise<void> {
    await this.#departments.rename(unsafeCompanyId(companyId), id, name);
  }

  async deleteDepartment(companyId: string, id: string): Promise<void> {
    await this.#departments.delete(unsafeCompanyId(companyId), id);
  }

  async addMember(companyId: string, departmentId: string, userId: string): Promise<void> {
    await this.#departments.addMember(
      unsafeCompanyId(companyId),
      departmentId,
      unsafeUserId(userId),
    );
  }

  async removeMember(companyId: string, departmentId: string, userId: string): Promise<void> {
    await this.#departments.removeMember(
      unsafeCompanyId(companyId),
      departmentId,
      unsafeUserId(userId),
    );
  }

  /* ---------------------------------------------------------------- roles -- */

  async listRoles(companyId: string): Promise<unknown[]> {
    const rows = await this.#roles.list(unsafeCompanyId(companyId));
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      scope: row.scope,
      isEditable: row.isEditable,
      companyId: row.companyId,
    }));
  }

  async listPermissions(companyId: string): Promise<{ key: string; category: string }[]> {
    return this.#roles.listPermissions(unsafeCompanyId(companyId));
  }

  async createRole(
    companyId: string,
    actorId: string,
    body: CreateRoleBody,
  ): Promise<{ id: string }> {
    return this.#roles.create(unsafeCompanyId(companyId), unsafeUserId(actorId), {
      key: body.key,
      name: body.name,
      scope: body.scope,
      permissionKeys: body.permissionKeys,
    });
  }

  async updateRole(
    companyId: string,
    actorId: string,
    roleId: string,
    body: UpdateRoleBody,
  ): Promise<void> {
    await this.#roles.update(unsafeCompanyId(companyId), unsafeUserId(actorId), roleId, {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.permissionKeys === undefined ? {} : { permissionKeys: body.permissionKeys }),
    });
  }

  async deleteRole(companyId: string, roleId: string): Promise<void> {
    await this.#roles.delete(unsafeCompanyId(companyId), roleId);
  }

  async listAssignments(companyId: string, userId: string): Promise<unknown[]> {
    const rows = await this.#roles.listAssignments(
      unsafeCompanyId(companyId),
      unsafeUserId(userId),
    );
    return rows.map((row) => ({
      id: row.id,
      roleId: row.roleId,
      roleKey: row.roleKey,
      departmentId: row.departmentId,
      createdAt: toIso(row.createdAt),
    }));
  }

  async assignRole(
    companyId: string,
    actorId: string,
    userId: string,
    body: AssignRoleBody,
  ): Promise<{ id: string }> {
    return this.#roles.assign(
      unsafeCompanyId(companyId),
      unsafeUserId(actorId),
      unsafeUserId(userId),
      {
        roleId: body.roleId,
        departmentId: body.departmentId ?? null,
      },
    );
  }

  async revokeAssignment(companyId: string, userId: string, assignmentId: string): Promise<void> {
    await this.#roles.revoke(unsafeCompanyId(companyId), unsafeUserId(userId), assignmentId);
  }

  /* ------------------------------------------------------------- platform -- */

  async listCompanies(): Promise<unknown[]> {
    const rows = await this.#platform.listCompanies();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      createdAt: toIso(row.createdAt),
    }));
  }

  async startImpersonation(
    platformUserId: string,
    companyId: string,
    body: ImpersonateBody,
    traceId: string,
  ): Promise<{ grantId: string; expiresAt: string }> {
    const result = await this.#platform.startImpersonation(
      unsafeUserId(platformUserId),
      {
        companyId,
        reason: body.reason,
        ...(body.minutes === undefined ? {} : { minutes: body.minutes }),
      },
      traceId,
    );
    return { grantId: result.grantId, expiresAt: result.expiresAt.toISOString() };
  }

  async endImpersonation(platformUserId: string, grantId: string, traceId: string): Promise<void> {
    await this.#platform.endImpersonation(unsafeUserId(platformUserId), grantId, traceId);
  }
}
