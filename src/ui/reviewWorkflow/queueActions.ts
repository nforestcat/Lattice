import type {
  ReviewItemStatus,
  ReviewQueueItem,
} from "../../api/types";
import type { ReviewActionResult } from "./contracts";
import { runReservedReviewAction } from "./actionExecution";
import type { ReviewApplyExecutor } from "./actionExecution";
import {
  actionFailure,
  cachedSuccess,
  inFlightResult,
  normalizeMutation,
  supportsAction,
} from "./actionGuards";
import type { ReviewLedger, ReviewLedgerEntry } from "./ledger";
import { transitionReviewStatus } from "./stateMachine";

type ApprovalResult = boolean | void | Promise<boolean | void>;
type ApprovalExecutor = () => ApprovalResult;

export type ReviewActionAdapters = {
  readonly getApprovalExecutor: (
    item: ReviewQueueItem,
    operation: "approve" | "reject"
  ) => ApprovalExecutor | undefined;
  readonly getApplyExecutor: (
    item: ReviewQueueItem
  ) => ReviewApplyExecutor | undefined;
};

export type ReviewQueueActions = {
  readonly approveItem: (id: string) => Promise<ReviewActionResult>;
  readonly rejectItem: (id: string) => Promise<ReviewActionResult>;
  readonly applyItem: (
    id: string,
    executor?: ReviewApplyExecutor
  ) => Promise<ReviewActionResult>;
};

type ReviewQueueActionContext = {
  readonly ledger: ReviewLedger;
  readonly publish: () => void;
  readonly adapters: ReviewActionAdapters;
};

export function createReviewQueueActions(
  context: ReviewQueueActionContext
): ReviewQueueActions {
  const { ledger, publish, adapters } = context;
  const publishIfCurrent = (entry: ReviewLedgerEntry): void => {
    if (ledger.get(entry.item.id) === entry) {
      publish();
    }
  };

  function transitionItem(
    id: string,
    operation: "approve" | "reject",
    nextStatus: Extract<ReviewItemStatus, "approved" | "rejected">
  ): Promise<ReviewActionResult> {
    const entry = ledger.get(id);
    if (entry === undefined) {
      return Promise.resolve(
        actionFailure(
          operation,
          undefined,
          "not_found",
          `Review item ${id} was not found.`
        )
      );
    }
    const pending = inFlightResult(entry, operation);
    if (pending !== undefined) {
      return pending;
    }
    if (operation === "approve" && entry.status === "approved") {
      const cached = cachedSuccess(entry, operation);
      if (cached !== undefined) {
        return Promise.resolve(cached);
      }
    }
    if (!transitionReviewStatus(entry.status, operation).ok) {
      return Promise.resolve(
        actionFailure(
          operation,
          entry,
          "invalid_transition",
          `Cannot ${operation} an item with status ${entry.status}.`
        )
      );
    }
    if (!supportsAction(entry, operation)) {
      return Promise.resolve(
        actionFailure(
          operation,
          entry,
          "unsupported",
          `Review item ${id} does not support ${operation}.`
        )
      );
    }
    const executor = adapters.getApprovalExecutor(entry.item, operation);
    return runReservedReviewAction({
      entry,
      operation,
      publish: () => publishIfCurrent(entry),
      execute: async () => {
        if ((await executor?.()) === false) {
          return actionFailure(
            operation,
            entry,
            "declined",
            `${operation === "approve" ? "Approval" : "Rejection"} was declined.`
          );
        }
        entry.status = nextStatus;
        return operation === "approve"
          ? {
              ok: true,
              operation,
              itemId: id,
              status: "approved",
              deduplicated: false,
            }
          : {
              ok: true,
              operation,
              itemId: id,
              status: "rejected",
              deduplicated: false,
            };
      },
    });
  }

  function applyItem(
    id: string,
    executor?: ReviewApplyExecutor
  ): Promise<ReviewActionResult> {
    const entry = ledger.get(id);
    if (entry === undefined) {
      return Promise.resolve(
        actionFailure(
          "apply",
          undefined,
          "not_found",
          `Review item ${id} was not found.`
        )
      );
    }
    const pending = inFlightResult(entry, "apply");
    if (pending !== undefined) {
      return pending;
    }
    if (entry.status === "applied") {
      const cached = cachedSuccess(entry, "apply");
      if (cached !== undefined) {
        return Promise.resolve(cached);
      }
    }
    if (!transitionReviewStatus(entry.status, "apply").ok) {
      return Promise.resolve(
        actionFailure(
          "apply",
          entry,
          "invalid_transition",
          `Cannot apply an item with status ${entry.status}.`
        )
      );
    }
    const selectedExecutor = executor ?? adapters.getApplyExecutor(entry.item);
    if (!supportsAction(entry, "apply") || selectedExecutor === undefined) {
      return Promise.resolve(
        actionFailure(
          "apply",
          entry,
          "unsupported",
          `Review item ${id} does not support apply.`
        )
      );
    }
    return runReservedReviewAction({
      entry,
      operation: "apply",
      publish: () => publishIfCurrent(entry),
      execute: async () => {
        const execution = normalizeMutation(await selectedExecutor());
        if (execution.changedPaths.length === 0) {
          return {
            ...actionFailure(
              "apply",
              entry,
              "failed",
              "Apply completed without changing a path."
            ),
            warnings: execution.warnings,
          };
        }
        entry.status = "applied";
        entry.changedPaths = execution.changedPaths;
        entry.warnings = execution.warnings;
        return {
          ok: true,
          operation: "apply",
          itemId: id,
          status: "applied",
          changedPaths: execution.changedPaths,
          warnings: execution.warnings,
          deduplicated: false,
        };
      },
    });
  }

  return {
    approveItem: (id) => transitionItem(id, "approve", "approved"),
    rejectItem: (id) => transitionItem(id, "reject", "rejected"),
    applyItem,
  };
}
