import type {
  MaintenanceSuggestionKind,
  ReviewItemKind,
  ReviewItemStatus,
} from "../../api/types";

export const REVIEW_OPERATIONS = [
  "approve",
  "reject",
  "apply",
  "commit",
] as const;

export type ReviewOperation = (typeof REVIEW_OPERATIONS)[number];

export type ReviewActionFailureCode =
  | "not_found"
  | "unsupported"
  | "busy"
  | "invalid_transition"
  | "declined"
  | "failed";

export type ReviewActionWarningCode =
  | "post_action_failed"
  | "partial_failure"
  | "unrelated_staged_paths";

export type ReviewActionWarning = {
  readonly code: ReviewActionWarningCode;
  readonly message: string;
  readonly path?: string;
};

type ReviewActionSuccessBase = {
  readonly ok: true;
  readonly itemId: string;
  readonly deduplicated: boolean;
};

export type ReviewApproveSuccess = ReviewActionSuccessBase & {
  readonly operation: "approve";
  readonly status: "approved";
};

export type ReviewRejectSuccess = ReviewActionSuccessBase & {
  readonly operation: "reject";
  readonly status: "rejected";
};

export type ReviewApplySuccess = ReviewActionSuccessBase & {
  readonly operation: "apply";
  readonly status: "applied";
  readonly changedPaths: readonly string[];
  readonly warnings: readonly ReviewActionWarning[];
};

export type ReviewCommitSuccess = ReviewActionSuccessBase & {
  readonly operation: "commit";
  readonly status: "committed";
  readonly changedPaths: readonly string[];
  readonly committedIds: readonly string[];
  readonly warnings: readonly ReviewActionWarning[];
};

export type ReviewActionSuccess =
  | ReviewApproveSuccess
  | ReviewRejectSuccess
  | ReviewApplySuccess
  | ReviewCommitSuccess;

export type ReviewActionFailure = {
  readonly ok: false;
  readonly operation: ReviewOperation;
  readonly itemId: string | null;
  readonly status: ReviewItemStatus | null;
  readonly code: ReviewActionFailureCode;
  readonly message: string;
  readonly warnings: readonly ReviewActionWarning[];
};

export type ReviewActionResult = ReviewActionSuccess | ReviewActionFailure;

export type ReviewCapabilities = {
  readonly approve: boolean;
  readonly reject: boolean;
  readonly apply: boolean;
  readonly commit: boolean;
};

export type ReviewCapabilityInput = {
  readonly kind: ReviewItemKind;
  readonly status: ReviewItemStatus;
  readonly suggestionKind?: MaintenanceSuggestionKind | undefined;
  readonly hasGeneratedSuggestion?: boolean | undefined;
};

export type ReviewTransitionResult =
  | {
      readonly ok: true;
      readonly status: ReviewItemStatus;
    }
  | {
      readonly ok: false;
      readonly code: "invalid_transition";
      readonly operation: ReviewOperation;
      readonly status: ReviewItemStatus;
    };
