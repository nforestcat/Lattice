import type {
  ReviewItemStatus,
  ReviewQueueItem,
} from "../../api/ingestReviewTypes";
import type {
  ReviewActionFailure,
  ReviewActionSuccess,
  ReviewActionWarning,
  ReviewOperation,
} from "./contracts";

export type ReviewOperationAttempts = Readonly<Record<ReviewOperation, number>>;

export type ReviewOperationFailures = Readonly<
  Partial<Record<ReviewOperation, ReviewActionFailure>>
>;

export type ReviewInFlight = {
  readonly operation: ReviewOperation;
  readonly promise: Promise<import("./contracts").ReviewActionResult>;
};

export type ReviewCommitFailureMetadata = {
  readonly attemptedPaths: readonly string[];
  readonly failure: ReviewActionFailure;
};

export type ReviewWorkflowItem = Omit<ReviewQueueItem, "status"> & {
  readonly status: ReviewItemStatus;
  readonly changedPaths: readonly string[];
  readonly warnings: readonly ReviewActionWarning[];
  readonly attempts: ReviewOperationAttempts;
  readonly failures: ReviewOperationFailures;
  readonly inFlight: ReviewInFlight | null;
  readonly commitFailure: ReviewCommitFailureMetadata | null;
};

export type ReviewLedgerEntry = {
  item: ReviewQueueItem;
  status: ReviewItemStatus;
  changedPaths: readonly string[];
  warnings: readonly ReviewActionWarning[];
  attempts: Record<ReviewOperation, number>;
  failures: Partial<Record<ReviewOperation, ReviewActionFailure>>;
  successes: Partial<Record<ReviewOperation, ReviewActionSuccess>>;
  inFlight: ReviewInFlight | null;
  commitFailure: ReviewCommitFailureMetadata | null;
};

export type ReviewLedger = Map<string, ReviewLedgerEntry>;

function createEntry(item: ReviewQueueItem): ReviewLedgerEntry {
  return {
    item,
    status: item.status,
    changedPaths: [],
    warnings: [],
    attempts: { approve: 0, reject: 0, apply: 0, commit: 0 },
    failures: {},
    successes: {},
    inFlight: null,
    commitFailure: null,
  };
}

export function synchronizeReviewLedger(
  ledger: ReviewLedger,
  items: readonly ReviewQueueItem[]
): void {
  const currentIds = new Set(items.map((item) => item.id));
  for (const id of ledger.keys()) {
    if (!currentIds.has(id)) {
      ledger.delete(id);
    }
  }
  for (const item of items) {
    const existing = ledger.get(item.id);
    if (existing === undefined) {
      ledger.set(item.id, createEntry(item));
    } else {
      existing.item = item;
    }
  }
}

export function projectReviewItem(entry: ReviewLedgerEntry): ReviewWorkflowItem {
  return {
    ...entry.item,
    status: entry.status,
    changedPaths: entry.changedPaths,
    warnings: entry.warnings,
    attempts: { ...entry.attempts },
    failures: { ...entry.failures },
    inFlight: entry.inFlight,
    commitFailure: entry.commitFailure,
  };
}
