import type {
  ReviewActionFailure,
  ReviewActionResult,
  ReviewCommitSuccess,
} from "./contracts";
import type { ReviewLedger, ReviewLedgerEntry } from "./ledger";
import { normalizeReviewPath } from "./stateMachine";

export type MarkCommittedPathsResult = {
  readonly result: ReviewActionResult;
  readonly committedIds: readonly string[];
};

function normalizePaths(paths: readonly string[]): readonly string[] {
  return [
    ...new Set(
      paths.map(normalizeReviewPath).filter((path) => path.length > 0)
    ),
  ].sort();
}

function fullyCovered(
  entry: ReviewLedgerEntry,
  attemptedPaths: ReadonlySet<string>
): boolean {
  return (
    entry.status === "applied" &&
    entry.changedPaths.length > 0 &&
    entry.changedPaths.every((path) => attemptedPaths.has(path))
  );
}

function eligibleEntries(
  ledger: ReviewLedger,
  paths: readonly string[]
): readonly ReviewLedgerEntry[] {
  const attemptedPaths = new Set(paths);
  return [...ledger.values()].filter((entry) =>
    fullyCovered(entry, attemptedPaths)
  );
}

export function markCommittedPaths(
  ledger: ReviewLedger,
  paths: readonly string[],
  publish: () => void
): MarkCommittedPathsResult {
  const normalizedPaths = normalizePaths(paths);
  const entries = eligibleEntries(ledger, normalizedPaths);
  const committedIds = entries.map((entry) => entry.item.id);
  if (entries.length === 0) {
    return {
      committedIds,
      result: {
        ok: false,
        operation: "commit",
        itemId: null,
        status: null,
        code: "not_found",
        message: "No applied review items were fully covered by committed paths.",
        warnings: [],
      },
    };
  }
  for (const entry of entries) {
    const success: ReviewCommitSuccess = {
      ok: true,
      operation: "commit",
      itemId: entry.item.id,
      status: "committed",
      changedPaths: entry.changedPaths,
      committedIds,
      warnings: [],
      deduplicated: false,
    };
    entry.attempts.commit += 1;
    entry.status = "committed";
    entry.successes.commit = success;
    delete entry.failures.commit;
    entry.commitFailure = null;
  }
  publish();
  return {
    committedIds,
    result: {
      ok: true,
      operation: "commit",
      itemId: committedIds[0] ?? "",
      status: "committed",
      changedPaths: normalizedPaths,
      committedIds,
      warnings: [],
      deduplicated: false,
    },
  };
}

export function recordCommitFailure(
  ledger: ReviewLedger,
  attemptedPaths: readonly string[],
  failure: ReviewActionFailure,
  publish: () => void
): readonly string[] {
  const normalizedPaths = normalizePaths(attemptedPaths);
  const entries = eligibleEntries(ledger, normalizedPaths);
  for (const entry of entries) {
    entry.attempts.commit += 1;
    entry.failures.commit = failure;
    entry.commitFailure = {
      attemptedPaths: normalizedPaths,
      failure,
    };
  }
  if (entries.length > 0) {
    publish();
  }
  return entries.map((entry) => entry.item.id);
}
