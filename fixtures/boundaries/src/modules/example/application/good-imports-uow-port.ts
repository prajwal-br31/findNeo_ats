// Legal and central (D-044, ER-004a): the application depends on the port in
// shared/, never on platform/db.
import type { UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
export const run = async (uow: UnitOfWorkPort, companyId: string): Promise<void> => {
  await uow.withTenant(companyId, async () => undefined);
};
