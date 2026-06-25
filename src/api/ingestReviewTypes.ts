export type IngestRaw = {
  readonly title?: string;
  readonly text: string;
  readonly sourceRef: string;
  readonly sourceType?: "url" | "pdf" | "text";
  readonly ingestDate?: string;
};

export type IngestResult = {
  readonly title: string;
  readonly markdown: string;
  readonly tags: readonly string[];
};

export type IngestSimilarNote = {
  readonly path: string;
  readonly title: string;
};

export type IngestDuplicateCheck = {
  readonly exactMatch: string | null;
  readonly similarNotes: readonly IngestSimilarNote[];
};

export type AiAuditRecord = {
  readonly editId: string;
  readonly editType: "create" | "update" | "merge" | "delete";
  readonly path: string;
  readonly promptRunId?: string | null;
  readonly model?: string;
  readonly source: string;
  readonly appliedAt: string;
  readonly confidence?: number;
};

export type AiProvenance = {
  readonly source: string;
  readonly promptRunId?: string | null;
  readonly contextBundlePaths?: readonly string[];
  readonly originalExcerpt?: string;
  readonly confidence?: number;
  readonly model?: string;
  readonly appliedAt?: string;
};

export type SourceMutationWarning = {
  readonly code: "post_action_failed" | "partial_failure";
  readonly message: string;
  readonly path?: string;
};

export type SourceMutationResult = {
  readonly changedPaths: readonly string[];
  readonly warnings: readonly SourceMutationWarning[];
};

export type ReviewItemKind =
  | "inbox_capture"
  | "ingest_capture"
  | "ingest_draft"
  | "proposed_edit"
  | "missing_summary"
  | "dead_link"
  | "backlink_suggestion"
  | "duplicate_warning"
  | "orphan_note"
  | "stale_note"
  | "too_broad"
  | "weak_backlinks";

export type MaintenanceSuggestionKind =
  | "split"
  | "summary"
  | "link_candidates"
  | "review_prompt"
  | "merge_or_delete"
  | "backlinks_in";

export type ReviewItemStatus =
  | "drafted"
  | "approved"
  | "applied"
  | "rejected"
  | "committed";

export interface ReviewQueueItem {
  readonly id: string;
  readonly sourceId: string;
  readonly kind: ReviewItemKind;
  readonly status: ReviewItemStatus;
  readonly path: string;
  readonly title: string;
  readonly original?: string;
  readonly proposed?: string;
  readonly reason?: string;
  readonly gitStaged: boolean;
  readonly createdAt: number;
  readonly sourceRef?: unknown;
  readonly provenance?: AiProvenance;
  readonly suggestionKind?: MaintenanceSuggestionKind;
}

export type IngestQueueItem = {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly markdown: string;
  readonly raw: IngestRaw;
  readonly targetFolder: string;
  readonly appendTargetPath: string | null;
  readonly duplicateExact: string | null;
  readonly similarNotes: readonly IngestSimilarNote[];
  readonly suggestedLinks: readonly IngestSimilarNote[];
  readonly createdAt: number;
};

export type IngestQueueUpdate = Partial<
  Pick<IngestQueueItem, "title" | "tags" | "markdown" | "targetFolder" | "appendTargetPath">
>;

export type StubDraftReview = {
  readonly content: string;
  readonly status: "done" | "drafting" | "error";
};

export type ReviewDecisionRecord = {
  readonly id: string;
  readonly sourceId: string;
  readonly kind: ReviewItemKind;
  readonly status: ReviewItemStatus;
  readonly decidedAt: string;
};
