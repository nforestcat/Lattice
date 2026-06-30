import type {
  MaintenanceSuggestionKind,
  ReviewItemKind,
  ReviewItemStatus,
} from "../../api/types";
import type {
  ReviewCapabilities,
  ReviewCapabilityInput,
  ReviewOperation,
  ReviewTransitionResult,
} from "./contracts";

export * from "./contracts";

export function normalizeReviewPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
}

class UnexpectedReviewWorkflowVariantError extends Error {
  readonly name = "UnexpectedReviewWorkflowVariantError";

  constructor(readonly value: never) {
    super(`Unexpected review workflow variant: ${String(value)}`);
  }
}

function assertNever(value: never): never {
  throw new UnexpectedReviewWorkflowVariantError(value);
}

function invalidTransition(
  status: ReviewItemStatus,
  operation: ReviewOperation
): ReviewTransitionResult {
  return { ok: false, code: "invalid_transition", operation, status };
}

function hasMaintenanceAdapter(
  kind: ReviewItemKind,
  suggestionKind: MaintenanceSuggestionKind | undefined
): boolean {
  switch (suggestionKind) {
    case "summary":
      return kind === "missing_summary";
    case "link_candidates":
      return kind === "orphan_note";
    case "review_prompt":
      return kind === "stale_note";
    case "backlinks_in":
      return kind === "weak_backlinks";
    case "split":
    case "merge_or_delete":
    case undefined:
      return false;
    default:
      return assertNever(suggestionKind);
  }
}

function hasApplyAdapter(input: ReviewCapabilityInput): boolean {
  switch (input.kind) {
    case "inbox_capture":
    case "ingest_capture":
    case "ingest_draft":
    case "proposed_edit":
    case "backlink_suggestion":
      return true;
    case "missing_summary":
    case "dead_link":
    case "duplicate_warning":
    case "orphan_note":
    case "stale_note":
    case "too_broad":
    case "weak_backlinks":
      return hasMaintenanceAdapter(input.kind, input.suggestionKind);
    default:
      return assertNever(input.kind);
  }
}

function isDirectAdapterKind(kind: ReviewItemKind): boolean {
  switch (kind) {
    case "inbox_capture":
    case "ingest_capture":
    case "ingest_draft":
    case "proposed_edit":
    case "backlink_suggestion":
      return true;
    case "missing_summary":
    case "dead_link":
    case "duplicate_warning":
    case "orphan_note":
    case "stale_note":
    case "too_broad":
    case "weak_backlinks":
      return false;
    default:
      return assertNever(kind);
  }
}

export function getReviewCapabilities(
  input: ReviewCapabilityInput
): ReviewCapabilities {
  const applyAdapter = hasApplyAdapter(input);
  switch (input.status) {
    case "drafted":
      return {
        approve:
          applyAdapter &&
          (isDirectAdapterKind(input.kind) ||
            input.hasGeneratedSuggestion === true),
        reject: true,
        apply: false,
        commit: false,
      };
    case "approved":
      return {
        approve: false,
        reject: true,
        apply: applyAdapter,
        commit: false,
      };
    case "applied":
      return {
        approve: false,
        reject: false,
        apply: false,
        commit: true,
      };
    case "rejected":
    case "committed":
      return {
        approve: false,
        reject: false,
        apply: false,
        commit: false,
      };
    default:
      return assertNever(input.status);
  }
}

export function transitionReviewStatus(
  status: ReviewItemStatus,
  operation: ReviewOperation
): ReviewTransitionResult {
  switch (status) {
    case "drafted":
      switch (operation) {
        case "approve":
          return { ok: true, status: "approved" };
        case "reject":
          return { ok: true, status: "rejected" };
        case "apply":
        case "commit":
          return invalidTransition(status, operation);
        default:
          return assertNever(operation);
      }
    case "approved":
      switch (operation) {
        case "reject":
          return { ok: true, status: "rejected" };
        case "apply":
          return { ok: true, status: "applied" };
        case "approve":
        case "commit":
          return invalidTransition(status, operation);
        default:
          return assertNever(operation);
      }
    case "applied":
      switch (operation) {
        case "commit":
          return { ok: true, status: "committed" };
        case "approve":
        case "reject":
        case "apply":
          return invalidTransition(status, operation);
        default:
          return assertNever(operation);
      }
    case "rejected":
    case "committed":
      return invalidTransition(status, operation);
    default:
      return assertNever(status);
  }
}
