import { useState, useMemo, useEffect } from "react";
import { buildCommitBundle } from "./commitBundle";
import type { CommitBundle } from "./commitBundle";
import type { InboxCaptureBlock } from "../../core/capture";
import type {
  StubDraftReview,
  ProposedEdit,
  NoteHealthReport,
  BacklinkSuggestion,
  IngestQueueItem,
  IngestQueueUpdate,
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
  adaptIngestCapture,
} from "./reviewQueueAdapters";

type ApprovalResult = boolean | void | Promise<boolean | void>;
type ApplyResult = readonly string[] | false | Promise<readonly string[] | false>;

export interface ReviewQueueSources {
  inboxCaptures: InboxCaptureBlock[];
  bulkDrafts: Record<string, StubDraftReview>;
  proposedEdits: ProposedEdit[];
  healthReports: NoteHealthReport[];
  backlinkSuggestions: BacklinkSuggestion[];
  ingestItems: IngestQueueItem[];
  gitStagedPaths?: Set<string>;
  onApplyInboxCapture?: (id: string) => ApplyResult;
  onApplyProposedEdit?: (id: string) => ApplyResult;
  onApplyBacklinkSuggestion?: (id: string) => ApplyResult;
  onApplyIngestCapture?: (id: string) => ApplyResult;
  onApproveStubDraft?: (target: string) => ApprovalResult;
  onRejectStubDraft?: (target: string) => ApprovalResult;
  onApproveIngestCapture?: (id: string) => ApprovalResult;
  onRejectIngestCapture?: (id: string) => ApprovalResult;
  onUpdateIngestCapture?: (id: string, patch: IngestQueueUpdate) => void;
}

export interface ReviewQueueHook {
  items: ReviewQueueItem[];
  filterItems: (kind?: ReviewItemKind, status?: ReviewItemStatus) => ReviewQueueItem[];
  applyItem: (id: string) => Promise<readonly string[]>;
  approveItem: (id: string) => Promise<void>;
  rejectItem: (id: string) => Promise<void>;
  updateIngestCapture: (id: string, patch: IngestQueueUpdate) => void;
  commitBundle: CommitBundle;
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
    ingestItems,
    gitStagedPaths,
    onApplyInboxCapture,
    onApplyProposedEdit,
    onApplyBacklinkSuggestion,
    onApplyIngestCapture,
    onApproveStubDraft,
    onRejectStubDraft,
    onApproveIngestCapture,
    onRejectIngestCapture,
    onUpdateIngestCapture,
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

    for (const ingest of ingestItems) {
      result.push(adaptIngestCapture(ingest));
    }


    return result
      .map((item) =>
        gitStagedPaths ? { ...item, gitStaged: gitStagedPaths.has(item.path) } : item
      )
      .sort(sortItems);
  }, [inboxCaptures, bulkDrafts, proposedEdits, healthReports, backlinkSuggestions, ingestItems, gitStagedPaths]);

  // Prune overrides for ids not present in current baseItems
  useEffect(() => {
    const currentIds = new Set(baseItems.map((item) => item.id));
    setOverrides((prev) => {
      const pruned: Record<string, ReviewItemStatus> = {};
      let changed = false;
      for (const [id, status] of Object.entries(prev)) {
        if (currentIds.has(id)) {
          pruned[id] = status;
        } else {
          changed = true;
        }
      }
      return changed ? pruned : prev;
    });
  }, [baseItems]);

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
    onTransition?: (item: ReviewQueueItem) => ApprovalResult
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

  async function applyItem(id: string): Promise<readonly string[]> {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return [];
    let result: readonly string[] | false = false;
    if (item.kind === "inbox_capture") result = await (onApplyInboxCapture?.(item.sourceId) ?? false);
    if (item.kind === "proposed_edit") result = await (onApplyProposedEdit?.(item.sourceId) ?? false);
    if (item.kind === "backlink_suggestion") result = await (onApplyBacklinkSuggestion?.(item.sourceId) ?? false);
    if (item.kind === "ingest_capture") result = await (onApplyIngestCapture?.(item.sourceId) ?? false);
    if (result === false) {
      if (!["inbox_capture", "proposed_edit", "backlink_suggestion", "ingest_capture"].includes(item.kind)) {
        console.warn(`applyItem: unhandled kind "${item.kind}" for item ${id}`);
      }
      return [];
    }
    if (result.length === 0) return [];
    setOverrides((prev) => ({ ...prev, [id]: "applied" }));
    return result;
  }

  async function approveItem(id: string) {
    await transitionItem(id, "approved", (item) => {
      if (item.kind === "ingest_draft") return onApproveStubDraft?.(item.sourceId);
      if (item.kind === "ingest_capture") return onApproveIngestCapture?.(item.sourceId);
      return undefined;
    });
  }

  async function rejectItem(id: string) {
    await transitionItem(id, "rejected", (item) => {
      if (item.kind === "ingest_draft") return onRejectStubDraft?.(item.sourceId);
      if (item.kind === "ingest_capture") return onRejectIngestCapture?.(item.sourceId);
      return undefined;
    });
  }

  function updateIngestCapture(id: string, patch: IngestQueueUpdate) {
    onUpdateIngestCapture?.(id, patch);
  }

  const commitBundle = useMemo(() => buildCommitBundle(items), [items]);

  return { items, filterItems, applyItem, approveItem, rejectItem, updateIngestCapture, commitBundle };
}
