import type { ResumeCopyService } from '../../modules/candidates/application/resume-copy.service.js';
import type { TenantJobPayload } from '../../shared/ports/queue.js';
import type { TxScope } from '../../shared/ports/unit-of-work.js';
import { unsafeCompanyId } from '../../shared/types/ids.js';

/**
 * `resume.copy_for_application` (T-065, BR-060).
 *
 * A worker binds tenant context and calls an application service — nothing
 * more (ER-043). Every decision about what copying means lives in
 * `ResumeCopyService`, so the same behaviour is reachable from a test without
 * a queue, and so this file cannot grow a rule.
 *
 * Routed to `documents` rather than `recruitment` deliberately (ER-041a):
 * copying a 10 MB object is document work, and putting it in the recruitment
 * queue would let a large copy stall stage transitions behind it.
 *
 * **The `JobContext` type is described structurally rather than imported.**
 * `bootstrap` composes the fleet and a worker may not import it (ER-001); the
 * composition root is the one place that knows both this function and the
 * registry it goes into.
 */

interface ResumeCopyPayload extends TenantJobPayload {
  readonly applicationId: string;
  readonly sourceResumeId: string;
}

interface Context {
  /** Already bound to `payload.companyId` by the fleet. */
  readonly tx: TxScope;
  readonly payload: ResumeCopyPayload;
}

export function createResumeCopyHandler(
  service: ResumeCopyService,
): (context: Context) => Promise<void> {
  return async ({ tx, payload }: Context): Promise<void> => {
    await service.copyForApplication(
      tx,
      unsafeCompanyId(payload.companyId),
      payload.applicationId,
      payload.sourceResumeId,
    );
  };
}
