import type {
  ReviewActionFailure,
  ReviewActionResult,
  ReviewActionWarning,
  ReviewOperation,
} from "./contracts";
import type { ReviewLedgerEntry } from "./ledger";

export type ReviewApplyExecution = {
  readonly changedPaths: readonly string[];
  readonly warnings: readonly ReviewActionWarning[];
};

export type ReviewApplyExecutor = () =>
  | ReviewApplyExecution
  | Promise<ReviewApplyExecution>;

type ReservedActionRequest = {
  readonly entry: ReviewLedgerEntry;
  readonly operation: Exclude<ReviewOperation, "commit">;
  readonly execute: () => ReviewActionResult | Promise<ReviewActionResult>;
  readonly publish: () => void;
};

function failureFromError(
  entry: ReviewLedgerEntry,
  operation: Exclude<ReviewOperation, "commit">,
  error: unknown
): ReviewActionFailure {
  return {
    ok: false,
    operation,
    itemId: entry.item.id,
    status: entry.status,
    code: "failed",
    message: error instanceof Error ? error.message : String(error),
    warnings: [],
  };
}

export function runReservedReviewAction(
  request: ReservedActionRequest
): Promise<ReviewActionResult> {
  const { entry, operation, execute, publish } = request;
  if (entry.inFlight !== null) {
    if (entry.inFlight.operation === operation) {
      return entry.inFlight.promise;
    }
    return Promise.resolve({
      ok: false,
      operation,
      itemId: entry.item.id,
      status: entry.status,
      code: "busy",
      message: `${entry.inFlight.operation} is already in progress.`,
      warnings: [],
    });
  }

  let complete = (_result: ReviewActionResult): void => undefined;
  const promise = new Promise<ReviewActionResult>((resolve) => {
    complete = resolve;
  });
  entry.attempts[operation] += 1;
  entry.inFlight = { operation, promise };
  publish();

  Promise.resolve()
    .then(execute)
    .then(
      (result) => {
        if (result.ok) {
          entry.successes[operation] = result;
          delete entry.failures[operation];
        } else {
          entry.failures[operation] = result;
        }
        entry.inFlight = null;
        publish();
        complete(result);
      },
      (error: unknown) => {
        const failure = failureFromError(entry, operation, error);
        entry.failures[operation] = failure;
        entry.inFlight = null;
        publish();
        complete(failure);
      }
    );

  return promise;
}
