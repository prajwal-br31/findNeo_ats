import { conflict, notFound } from '../../../shared/errors/app-error.js';
import { decodeCursor, type CursorPayload } from '../../../shared/http/cursor.js';
import { paginate, resolveLimit, type Collection } from '../../../shared/http/envelope.js';
import type { TxScope, UnitOfWorkPort } from '../../../shared/ports/unit-of-work.js';
import type { CompanyId, UserId } from '../../../shared/types/ids.js';
import type {
  CandidateRow,
  CandidatesRepository,
  DuplicateMatchRow,
  UpdateCandidateInput,
} from '../infrastructure/candidates.repository.js';

/**
 * Candidates (T-062).
 *
 * The **mutable** half of D-009. Everything here can change; nothing here
 * reaches an application that has already been submitted. That separation is
 * the whole reason applications carry `snapshot_*` columns rather than
 * joining to this table.
 */

/**
 * How close two names must be to be worth mentioning. Tuned by what it costs
 * to be wrong in each direction: a missed duplicate creates a second profile
 * a recruiter later merges by hand, while a false positive makes them read
 * one extra name. 0.4 leans toward showing too much.
 */
const NAME_SIMILARITY_THRESHOLD = 0.4;

export interface CandidatesServiceDeps {
  readonly uow: UnitOfWorkPort;
  readonly repository: CandidatesRepository;
}

export interface CreateCandidateInput {
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly currentTitle: string | null;
  readonly currentEmployer: string | null;
  readonly totalExperienceYears: number | null;
  readonly currentCtc: number | null;
  readonly ctcCurrency: string | null;
  readonly educationLevel: string | null;
  readonly locationCity: string | null;
  readonly locationCountry: string | null;
  readonly linkedinUrl: string | null;
  readonly source: string;
}

export interface CreateCandidateResult {
  readonly id: string;
  /**
   * Possible duplicates found *before* the insert, reported alongside the
   * candidate that was nonetheless created (BR-061).
   */
  readonly possibleDuplicates: readonly DuplicateMatchRow[];
}

export class CandidatesService {
  readonly #deps: CandidatesServiceDeps;

  constructor(deps: CandidatesServiceDeps) {
    this.#deps = deps;
  }

  async list(
    companyId: CompanyId,
    query: { limit?: number; cursor?: string },
  ): Promise<Collection<CandidateRow>> {
    const { uow, repository } = this.#deps;
    const limit = resolveLimit(query.limit);
    const after: CursorPayload | undefined =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor);

    return uow.withTenant(companyId, async (tx: TxScope) => {
      const rows = await repository.list(tx, limit, after);
      return paginate(rows, limit, (row) => ({ sortValue: toIso(row.createdAt), id: row.id }));
    });
  }

  async get(companyId: CompanyId, id: string): Promise<CandidateRow> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, async (tx: TxScope) => {
      const row = await repository.findById(tx, id);
      /* 404 covers "no such candidate" and "another tenant's" alike (SEC-026).
         A 403 on the second would confirm the row exists. */
      if (row === undefined) throw notFound('Candidate not found.');
      return row;
    });
  }

  /** Read-only duplicate check, for a client that wants to warn before saving. */
  async findDuplicates(
    companyId: CompanyId,
    fullName: string,
    email: string | null,
  ): Promise<DuplicateMatchRow[]> {
    const { uow, repository } = this.#deps;
    return uow.withTenant(companyId, (tx: TxScope) =>
      repository.findPossibleDuplicates(tx, fullName, email, NAME_SIMILARITY_THRESHOLD),
    );
  }

  /**
   * Creates a candidate, reporting duplicates rather than refusing.
   *
   * **Advisory, never automatic** (BR-061). Two people genuinely do share a
   * name, and merging them is a data-integrity incident that cannot be undone
   * — so the match is surfaced and a human decides. The only hard stop is the
   * unique index on email, which is a real collision and not a guess.
   */
  async create(
    companyId: CompanyId,
    userId: UserId,
    input: CreateCandidateInput,
  ): Promise<CreateCandidateResult> {
    const { uow, repository } = this.#deps;

    return uow.withTenant(companyId, async (tx: TxScope) => {
      const possibleDuplicates = await repository.findPossibleDuplicates(
        tx,
        input.fullName,
        input.email,
        NAME_SIMILARITY_THRESHOLD,
      );

      try {
        const created = await repository.insert(tx, {
          companyId,
          createdBy: userId,
          ...input,
        });
        return { id: created.id, possibleDuplicates };
      } catch (error) {
        /* The unique index decided, not a prior SELECT. Two simultaneous
           creates with the same email would both pass a read-then-write
           check; only the constraint is authoritative. */
        if (isUniqueViolation(error)) {
          throw conflict('ERR_DUPLICATE', 'A candidate with that email already exists.');
        }
        throw error;
      }
    });
  }

  async update(companyId: CompanyId, id: string, input: UpdateCandidateInput): Promise<void> {
    const { uow, repository } = this.#deps;

    await uow.withTenant(companyId, async (tx: TxScope) => {
      const updated = await repository.update(tx, id, input);
      if (!updated) throw notFound('Candidate not found.');
    });
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === '23505') return true;
    current = candidate.cause;
  }
  return false;
}
