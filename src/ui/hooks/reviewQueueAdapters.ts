import type { InboxCaptureBlock } from "../../core/capture";
import type {
  StubDraftReview,
  ProposedEdit,
  NoteHealthReport,
  BacklinkSuggestion,
  ReviewQueueItem,
  ReviewItemKind,
} from "../../api/types";

function captureCreatedAt(title: string): number {
  const parsed = new Date(`${title.replace(" ", "T")}:00`).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function adaptInboxCapture(item: InboxCaptureBlock): ReviewQueueItem {
  return {
    id: item.id,
    sourceId: item.id,
    kind: "inbox_capture",
    status: "new",
    path: item.relatedTitle ?? "Inbox",
    title: item.title,
    proposed: item.markdown,
    gitStaged: false,
    createdAt: captureCreatedAt(item.title),
  };
}

export function adaptStubDraft(
  target: string,
  review: StubDraftReview
): ReviewQueueItem {
  const status =
    review.status === "drafting"
      ? "drafted"
      : review.approved
      ? "approved"
      : "new";
  return {
    id: `stub-${target}`,
    sourceId: target,
    kind: "ingest_draft",
    status,
    path: target,
    title: `Draft: ${target}`,
    proposed: review.content,
    gitStaged: false,
    createdAt: 0,
  };
}

export function adaptProposedEdit(edit: ProposedEdit): ReviewQueueItem {
  const status = edit.applied ? "applied" : edit.checked ? "approved" : "new";
  return {
    id: edit.id,
    sourceId: edit.id,
    kind: "proposed_edit",
    status,
    path: edit.path,
    title: `${edit.type}: ${edit.path}`,
    original: edit.targetContent,
    proposed: edit.replacementContent ?? edit.content,
    reason: edit.reason,
    gitStaged: false,
    createdAt: 0,
    sourceRef: edit,
    provenance: edit.provenance,
  };
}

export function adaptHealthIssue(
  report: NoteHealthReport,
  issue: string
): ReviewQueueItem {
  let kind: ReviewItemKind;
  if (issue === "missingSummary") {
    kind = "missing_summary";
  } else if (issue === "isDuplicated") {
    kind = "duplicate_warning";
  } else if (issue === "isOrphan") {
    kind = "orphan_note";
  } else if (issue === "isStale" || issue === "isTooBroad" || issue === "weakBacklinks") {
    kind = "stale_note";
  } else {
    kind = "dead_link";
  }
  return {
    id: `health-${report.path}-${issue}`,
    sourceId: report.path,
    kind,
    status: "new",
    path: report.path,
    title: `${report.title}: ${issue}`,
    gitStaged: false,
    createdAt: 0,
    sourceRef: report,
  };
}

export function adaptBacklinkSuggestion(
  sug: BacklinkSuggestion
): ReviewQueueItem {
  return {
    id: sug.id,
    sourceId: sug.id,
    kind: "backlink_suggestion",
    status: "new",
    path: sug.sourcePath,
    title: `링크 제안: ${sug.sourceTitle} → ${sug.targetTitle}`,
    proposed: `[[${sug.targetTitle}]]`,
    reason: sug.excerpt,
    gitStaged: false,
    createdAt: 0,
    sourceRef: sug,
  };
}
