import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BacklinkSuggestion,
  IngestQueueItem,
  IngestQueueUpdate,
  NoteHealthReport,
  ProposedEdit,
  ReviewItemKind,
  ReviewItemStatus,
  ReviewQueueItem,
  SourceMutationResult,
  StubDraftReview,
} from "../../api/types";
import type { InboxCaptureBlock } from "../../core/capture";
import type { ReviewActionFailure, ReviewActionResult } from "../reviewWorkflow/contracts";
import {
  markCommittedPaths as markLedgerCommittedPaths,
  recordCommitFailure as recordLedgerCommitFailure,
  type MarkCommittedPathsResult,
} from "../reviewWorkflow/commitAttribution";
import {
  projectReviewItem,
  synchronizeReviewLedger,
  type ReviewLedger,
  type ReviewWorkflowItem,
} from "../reviewWorkflow/ledger";
import {
  createReviewQueueActions,
  type ReviewActionAdapters,
} from "../reviewWorkflow/queueActions";
import { buildReviewQueueItems } from "../reviewWorkflow/queueItems";
import type { ReviewApplyExecutor } from "../reviewWorkflow/actionExecution";
import { buildCommitBundle, type CommitBundle } from "./commitBundle";

type ApprovalResult = boolean | void | Promise<boolean | void>;
type MutationResult = SourceMutationResult | Promise<SourceMutationResult>;

export interface ReviewQueueSources {
  readonly inboxCaptures: readonly InboxCaptureBlock[];
  readonly bulkDrafts: Readonly<Record<string, StubDraftReview>>;
  readonly proposedEdits: readonly ProposedEdit[];
  readonly healthReports: readonly NoteHealthReport[];
  readonly backlinkSuggestions: readonly BacklinkSuggestion[];
  readonly ingestItems: readonly IngestQueueItem[];
  readonly gitStagedPaths?: ReadonlySet<string> | undefined;
  readonly onApplyInboxCapture?: ((id: string) => MutationResult) | undefined;
  readonly onApplyProposedEdit?: ((id: string) => MutationResult) | undefined;
  readonly onApplyBacklinkSuggestion?: ((id: string) => MutationResult) | undefined;
  readonly onApplyIngestCapture?: ((id: string) => MutationResult) | undefined;
  readonly onApproveStubDraft?: ((target: string) => ApprovalResult) | undefined;
  readonly onRejectStubDraft?: ((target: string) => ApprovalResult) | undefined;
  readonly onApproveIngestCapture?: ((id: string) => ApprovalResult) | undefined;
  readonly onRejectIngestCapture?: ((id: string) => ApprovalResult) | undefined;
  readonly onUpdateIngestCapture?: (
    (id: string, patch: IngestQueueUpdate) => void
  ) | undefined;
}

export interface ReviewQueueHook {
  readonly items: readonly ReviewWorkflowItem[];
  readonly filterItems: (
    kind?: ReviewItemKind,
    status?: ReviewItemStatus
  ) => readonly ReviewWorkflowItem[];
  readonly applyItem: (
    id: string,
    executor?: ReviewApplyExecutor
  ) => Promise<ReviewActionResult>;
  readonly approveItem: (id: string) => Promise<ReviewActionResult>;
  readonly rejectItem: (id: string) => Promise<ReviewActionResult>;
  readonly markCommittedPaths: (
    paths: readonly string[]
  ) => MarkCommittedPathsResult;
  readonly recordCommitFailure: (
    attemptedPaths: readonly string[],
    failure: ReviewActionFailure
  ) => readonly string[];
  readonly updateIngestCapture: (id: string, patch: IngestQueueUpdate) => void;
  readonly commitBundle: CommitBundle;
}

function applyExecutor(
  item: ReviewQueueItem,
  sources: ReviewQueueSources
): ReviewApplyExecutor | undefined {
  switch (item.kind) {
    case "inbox_capture":
      return sources.onApplyInboxCapture === undefined
        ? undefined
        : () => sources.onApplyInboxCapture?.(item.sourceId) ?? {
            changedPaths: [],
            warnings: [],
          };
    case "proposed_edit":
      return sources.onApplyProposedEdit === undefined
        ? undefined
        : () => sources.onApplyProposedEdit?.(item.sourceId) ?? {
            changedPaths: [],
            warnings: [],
          };
    case "backlink_suggestion":
      return sources.onApplyBacklinkSuggestion === undefined
        ? undefined
        : () => sources.onApplyBacklinkSuggestion?.(item.sourceId) ?? {
            changedPaths: [],
            warnings: [],
          };
    case "ingest_capture":
      return sources.onApplyIngestCapture === undefined
        ? undefined
        : () => sources.onApplyIngestCapture?.(item.sourceId) ?? {
            changedPaths: [],
            warnings: [],
          };
    case "ingest_draft":
    case "missing_summary":
    case "dead_link":
    case "duplicate_warning":
    case "orphan_note":
    case "stale_note":
    case "too_broad":
    case "weak_backlinks":
      return undefined;
  }
}

function actionAdapters(sources: ReviewQueueSources): ReviewActionAdapters {
  return {
    getApprovalExecutor: (item, operation) => {
      if (item.kind === "ingest_draft") {
        const callback =
          operation === "approve"
            ? sources.onApproveStubDraft
            : sources.onRejectStubDraft;
        return callback === undefined
          ? undefined
          : () => callback(item.sourceId);
      }
      if (item.kind === "ingest_capture") {
        const callback =
          operation === "approve"
            ? sources.onApproveIngestCapture
            : sources.onRejectIngestCapture;
        return callback === undefined
          ? undefined
          : () => callback(item.sourceId);
      }
      return undefined;
    },
    getApplyExecutor: (item) => applyExecutor(item, sources),
  };
}

export function useReviewQueue(sources: ReviewQueueSources): ReviewQueueHook {
  const ledgerRef = useRef<ReviewLedger>(new Map());
  const mountedRef = useRef(true);
  const [ledgerRevision, setLedgerRevision] = useState(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const publish = () => {
    if (mountedRef.current) {
      setLedgerRevision((revision) => revision + 1);
    }
  };
  const baseItems = useMemo(
    () => buildReviewQueueItems(sources),
    [
      sources.inboxCaptures,
      sources.bulkDrafts,
      sources.proposedEdits,
      sources.healthReports,
      sources.backlinkSuggestions,
      sources.ingestItems,
      sources.gitStagedPaths,
    ]
  );
  synchronizeReviewLedger(ledgerRef.current, baseItems);
  const items = useMemo(
    () =>
      baseItems.flatMap((item) => {
        const entry = ledgerRef.current.get(item.id);
        return entry === undefined ? [] : [projectReviewItem(entry)];
      }),
    [baseItems, ledgerRevision]
  );
  const actions = createReviewQueueActions({
    ledger: ledgerRef.current,
    publish,
    adapters: actionAdapters(sources),
  });

  return {
    items,
    filterItems: (kind, status) =>
      items.filter(
        (item) =>
          (kind === undefined || item.kind === kind) &&
          (status === undefined || item.status === status)
      ),
    ...actions,
    markCommittedPaths: (paths) =>
      markLedgerCommittedPaths(ledgerRef.current, paths, publish),
    recordCommitFailure: (paths, failure) =>
      recordLedgerCommitFailure(ledgerRef.current, paths, failure, publish),
    updateIngestCapture: (id, patch) =>
      sources.onUpdateIngestCapture?.(id, patch),
    commitBundle: buildCommitBundle([...items]),
  };
}
