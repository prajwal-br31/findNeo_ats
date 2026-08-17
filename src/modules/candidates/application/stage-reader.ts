import type { TxScope } from '../../../shared/ports/unit-of-work.js';

/**
 * What this module needs to know about another module's pipelines, declared
 * structurally rather than imported.
 *
 * An application advances to a stage of its own job's pipeline (BR-063), so
 * the candidates module has to read stages — but stages belong to the jobs
 * module, and ER-007 forbids reaching into another module's repository. This
 * interface names the two facts required and nothing else; the composition
 * root supplies something that satisfies it.
 *
 * Deliberately not a call to `PipelineService`: that opens its own
 * transaction, and every read here happens inside the transaction that is
 * about to write. A read on a different connection would not see the rows
 * this transaction has written and would not be covered by its rollback.
 */
export interface StageReader {
  listStages(
    tx: TxScope,
    jobId: string,
  ): Promise<readonly { id: string; stageType: string; isTerminal: boolean }[]>;
}
