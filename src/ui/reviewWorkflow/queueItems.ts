import type {
  BacklinkSuggestion,
  IngestQueueItem,
  NoteHealthReport,
  ProposedEdit,
  ReviewItemStatus,
  ReviewQueueItem,
  StubDraftReview,
} from "../../api/types";
import type { InboxCaptureBlock } from "../../core/capture";
import {
  adaptBacklinkSuggestion,
  adaptHealthIssue,
  adaptInboxCapture,
  adaptIngestCapture,
  adaptProposedEdit,
  adaptStubDraft,
} from "../hooks/reviewQueueAdapters";

const ACTIVE_STATUSES = new Set<ReviewItemStatus>(["drafted"]);
const HEALTH_ISSUE_KEYS = [
  "missingSummary",
  "isDuplicated",
  "isOrphan",
  "isStale",
  "isTooBroad",
  "weakBacklinks",
] as const;

export type ReviewQueueInputs = {
  readonly inboxCaptures: readonly InboxCaptureBlock[];
  readonly bulkDrafts: Readonly<Record<string, StubDraftReview>>;
  readonly proposedEdits: readonly ProposedEdit[];
  readonly healthReports: readonly NoteHealthReport[];
  readonly backlinkSuggestions: readonly BacklinkSuggestion[];
  readonly ingestItems: readonly IngestQueueItem[];
  readonly gitStagedPaths?: ReadonlySet<string> | undefined;
};

function sortItems(a: ReviewQueueItem, b: ReviewQueueItem): number {
  const activeDifference =
    Number(ACTIVE_STATUSES.has(b.status)) -
    Number(ACTIVE_STATUSES.has(a.status));
  return activeDifference === 0
    ? b.createdAt - a.createdAt
    : activeDifference;
}

export function buildReviewQueueItems(
  inputs: ReviewQueueInputs
): readonly ReviewQueueItem[] {
  const items: ReviewQueueItem[] = [];
  for (const capture of inputs.inboxCaptures) {
    items.push(adaptInboxCapture(capture));
  }
  for (const [target, draft] of Object.entries(inputs.bulkDrafts)) {
    items.push(adaptStubDraft(target, draft));
  }
  for (const edit of inputs.proposedEdits) {
    items.push(adaptProposedEdit(edit));
  }
  for (const report of inputs.healthReports) {
    for (const key of HEALTH_ISSUE_KEYS) {
      if (report[key]) {
        items.push(adaptHealthIssue(report, key));
      }
    }
  }
  for (const suggestion of inputs.backlinkSuggestions) {
    items.push(adaptBacklinkSuggestion(suggestion));
  }
  for (const ingest of inputs.ingestItems) {
    items.push(adaptIngestCapture(ingest));
  }
  return items
    .map((item) => ({
      ...item,
      gitStaged: inputs.gitStagedPaths?.has(item.path) ?? item.gitStaged,
    }))
    .sort(sortItems);
}
