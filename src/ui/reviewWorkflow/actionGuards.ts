import type {
  ReviewActionFailure,
  ReviewActionResult,
  ReviewOperation,
} from "./contracts";
import type { ReviewApplyExecution } from "./actionExecution";
import type { ReviewLedgerEntry } from "./ledger";
import {
  getReviewCapabilities,
  normalizeReviewPath,
} from "./stateMachine";

export function actionFailure(
  operation: ReviewOperation,
  entry: ReviewLedgerEntry | undefined,
  code: ReviewActionFailure["code"],
  message: string
): ReviewActionFailure {
  return {
    ok: false,
    operation,
    itemId: entry?.item.id ?? null,
    status: entry?.status ?? null,
    code,
    message,
    warnings: [],
  };
}

export function supportsAction(
  entry: ReviewLedgerEntry,
  operation: Exclude<ReviewOperation, "commit">
): boolean {
  const capabilities = getReviewCapabilities({
    kind: entry.item.kind,
    status: entry.status,
    suggestionKind: entry.item.suggestionKind,
    hasGeneratedSuggestion: entry.item.proposed !== undefined,
  });
  return capabilities[operation];
}

export function normalizeMutation(
  result: ReviewApplyExecution
): ReviewApplyExecution {
  return {
    changedPaths: [
      ...new Set(
        result.changedPaths
          .map(normalizeReviewPath)
          .filter((path) => path.length > 0)
      ),
    ],
    warnings: result.warnings,
  };
}

export function cachedSuccess(
  entry: ReviewLedgerEntry,
  operation: "approve" | "apply"
): ReviewActionResult | undefined {
  const cached = entry.successes[operation];
  return cached === undefined
    ? undefined
    : { ...cached, deduplicated: true };
}

export function inFlightResult(
  entry: ReviewLedgerEntry,
  operation: Exclude<ReviewOperation, "commit">
): Promise<ReviewActionResult> | undefined {
  if (entry.inFlight === null) {
    return undefined;
  }
  return entry.inFlight.operation === operation
    ? entry.inFlight.promise
    : Promise.resolve(
        actionFailure(
          operation,
          entry,
          "busy",
          `${entry.inFlight.operation} is already in progress.`
        )
      );
}
