import { useState, useMemo } from "react";
import type { InboxCaptureBlock } from "../../core/capture";
import type {
  StubDraftReview,
  ProposedEdit,
  NoteHealthReport,
  BacklinkSuggestion,
  ReviewQueueItem,
  ReviewItemKind,
  ReviewItemStatus,
} from "../../api/types";
import {
  adaptInboxCapture,
  adaptStubDraft,
  adaptProposedEdit,
  adaptHealthIssue,
  adaptBacklinkSuggestion,
} from "./reviewQueueAdapters";

export interface ReviewQueueSources {
  inboxCaptures: InboxCaptureBlock[];
  bulkDrafts: Record<string, StubDraftReview>;
  proposedEdits: ProposedEdit[];
  healthReports: NoteHealthReport[];
  backlinkSuggestions: BacklinkSuggestion[];
  gitStagedPaths?: Set<string>;
  onApplyInboxCapture?: (id: string) => void;
  onApplyProposedEdit?: (id: string) => void;
  onApproveStubDraft?: (target: string) => void;
  onRejectStubDraft?: (target: string) => void;
}

export interface ReviewQueueHook {
  items: ReviewQueueItem[];
  filterItems: (kind?: ReviewItemKind, status?: ReviewItemStatus) => ReviewQueueItem[];
  applyItem: (id: string) => void;
  approveItem: (id: string) => void;
  rejectItem: (id: string) => void;
}

const ACTIVE_STATUSES: ReviewItemStatus[] = ["new", "drafted"];

function sortItems(a: ReviewQueueItem, b: ReviewQueueItem): number {
  const aActive = ACTIVE_STATUSES.includes(a.status) ? 0 : 1;
  const bActive = ACTIVE_STATUSES.includes(b.status) ? 0 : 1;
  if (aActive !== bActive) return aActive - bActive;
  return b.createdAt - a.createdAt;
}

export function useReviewQueue(sources: ReviewQueueSources): ReviewQueueHook {
  const {
    inboxCaptures,
    bulkDrafts,
    proposedEdits,
    healthReports,
    backlinkSuggestions,
    gitStagedPaths,
    onApplyInboxCapture,
    onApplyProposedEdit,
    onApproveStubDraft,
    onRejectStubDraft,
  } = sources;

  const [overrides, setOverrides] = useState<Record<string, ReviewItemStatus>>({});

  const baseItems = useMemo<ReviewQueueItem[]>(() => {
    const result: ReviewQueueItem[] = [];

    for (const capture of inboxCaptures) {
      result.push(adaptInboxCapture(capture));
    }

    for (const [target, draft] of Object.entries(bulkDrafts)) {
      result.push(adaptStubDraft(target, draft));
    }

    for (const edit of proposedEdits) {
      result.push(adaptProposedEdit(edit));
    }

    const healthIssueKeys = [
      "missingSummary",
      "isDuplicated",
      "isOrphan",
      "isStale",
      "isTooBroad",
      "weakBacklinks",
    ] as const;

    for (const report of healthReports) {
      for (const key of healthIssueKeys) {
        if (report[key]) {
          result.push(adaptHealthIssue(report, key));
        }
      }
    }

    for (const suggestion of backlinkSuggestions) {
      result.push(adaptBacklinkSuggestion(suggestion));
    }

    return result
      .map((item) =>
        gitStagedPaths ? { ...item, gitStaged: gitStagedPaths.has(item.path) } : item
      )
      .sort(sortItems);
  }, [inboxCaptures, bulkDrafts, proposedEdits, healthReports, backlinkSuggestions, gitStagedPaths]);

  const items = useMemo<ReviewQueueItem[]>(() => {
    return baseItems.map((item) =>
      overrides[item.id] !== undefined
        ? { ...item, status: overrides[item.id] }
        : item
    );
  }, [baseItems, overrides]);

  function filterItems(kind?: ReviewItemKind, status?: ReviewItemStatus): ReviewQueueItem[] {
    return items.filter((item) => {
      if (kind !== undefined && item.kind !== kind) return false;
      if (status !== undefined && item.status !== status) return false;
      return true;
    });
  }

  function transitionItem(
    id: string,
    status: ReviewItemStatus,
    onTransition?: (item: ReviewQueueItem) => void
  ) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    setOverrides(prev => ({ ...prev, [id]: status }));
    onTransition?.(item);
  }

  function applyItem(id: string) {
    transitionItem(id, "applied", (item) => {
      if (item.kind === "inbox_capture") onApplyInboxCapture?.(item.sourceId);
      if (item.kind === "proposed_edit") onApplyProposedEdit?.(item.sourceId);
    });
  }

  function approveItem(id: string) {
    transitionItem(id, "approved", (item) => {
      if (item.kind === "ingest_draft") onApproveStubDraft?.(item.sourceId);
    });
  }

  function rejectItem(id: string) {
    transitionItem(id, "rejected", (item) => {
      if (item.kind === "ingest_draft") onRejectStubDraft?.(item.sourceId);
    });
  }

  return { items, filterItems, applyItem, approveItem, rejectItem };
}
