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

type TransitionResult = boolean | void | Promise<boolean | void>;

export interface ReviewQueueSources {
  inboxCaptures: InboxCaptureBlock[];
  bulkDrafts: Record<string, StubDraftReview>;
  proposedEdits: ProposedEdit[];
  healthReports: NoteHealthReport[];
  backlinkSuggestions: BacklinkSuggestion[];
  gitStagedPaths?: Set<string>;
  onApplyInboxCapture?: (id: string) => TransitionResult;
  onApplyProposedEdit?: (id: string) => TransitionResult;
  onApplyBacklinkSuggestion?: (id: string) => TransitionResult;
  onApproveStubDraft?: (target: string) => TransitionResult;
  onRejectStubDraft?: (target: string) => TransitionResult;
}

export interface ReviewQueueHook {
  items: ReviewQueueItem[];
  filterItems: (kind?: ReviewItemKind, status?: ReviewItemStatus) => ReviewQueueItem[];
  applyItem: (id: string) => Promise<void>;
  approveItem: (id: string) => Promise<void>;
  rejectItem: (id: string) => Promise<void>;
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
    onApplyBacklinkSuggestion,
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

    console.log("[DEBUG] baseItems recompute", result.map(r => `${r.id}:${r.status}`));
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
    onTransition?: (item: ReviewQueueItem) => TransitionResult
  ): Promise<void> {
    const item = items.find((i) => i.id === id);
    if (!item) return Promise.resolve();

    return Promise.resolve(onTransition?.(item)).then((result) => {
      if (result === false) {
        return;
      }
      setOverrides(prev => ({ ...prev, [id]: status }));
    });
  }

  async function applyItem(id: string) {
    await transitionItem(id, "applied", (item) => {
      if (item.kind === "inbox_capture") return onApplyInboxCapture?.(item.sourceId) ?? false;
      if (item.kind === "proposed_edit") return onApplyProposedEdit?.(item.sourceId) ?? false;
      if (item.kind === "backlink_suggestion") return onApplyBacklinkSuggestion?.(item.sourceId) ?? false;
      return false;
    });
  }

  async function approveItem(id: string) {
    await transitionItem(id, "approved", (item) => {
      if (item.kind === "ingest_draft") return onApproveStubDraft?.(item.sourceId);
      return undefined;
    });
  }

  async function rejectItem(id: string) {
    await transitionItem(id, "rejected", (item) => {
      if (item.kind === "ingest_draft") return onRejectStubDraft?.(item.sourceId);
      return undefined;
    });
  }

  return { items, filterItems, applyItem, approveItem, rejectItem };
}
