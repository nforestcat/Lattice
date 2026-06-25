import { useState } from "react";
import type { AiProvenance, IngestQueueUpdate } from "../../api/types";
import type { ReviewWorkflowItem } from "../reviewWorkflow/ledger";
import { getReviewCapabilities } from "../reviewWorkflow/stateMachine";
import { IngestQueueReviewControls } from "./reviewQueue/IngestQueueReviewControls";
import { ActionButton } from "./reviewQueue/ReviewQueueActionButton";
import {
  DiffBlock,
  ProvenanceBlock,
  ReviewQueueItemHeader,
  ReviewQueuePreview,
} from "./reviewQueue/ReviewQueueBlocks";

type QueueActionHandler = (id: string) => void | Promise<void>;

interface ReviewItemCardProps {
  readonly item: ReviewWorkflowItem;
  readonly onApply: QueueActionHandler;
  readonly onApprove: QueueActionHandler;
  readonly onReject: QueueActionHandler;
  readonly generating?: Set<string>;
  readonly suggestions?: Record<string, string>;
  readonly provenances?: Record<string, AiProvenance>;
  readonly onGenerate?: (id: string) => void | Promise<void>;
  readonly onApplyMaintenance?: (id: string) => void | Promise<void>;
  readonly onStage?: (id: string) => void | Promise<void>;
  readonly canStage?: boolean;
  readonly isStagedByQueue?: boolean;
  readonly onUpdateIngestCapture?: (id: string, patch: IngestQueueUpdate) => void;
}

const GENERATE_LABELS: Record<string, string> = {
  summary: "Generate Summary",
  split: "Suggest Split",
  link_candidates: "Find Link Candidates",
  review_prompt: "Suggest Review",
  merge_or_delete: "Suggest Merge/Delete",
  backlinks_in: "Find Inbound Links",
};

const PREVIEWABLE_SUGGESTION_KINDS = new Set(["link_candidates", "backlinks_in", "review_prompt"]);

export function ReviewQueueItemCard({
  item,
  onApply,
  onApprove,
  onReject,
  generating = new Set(),
  suggestions = {},
  provenances = {},
  onGenerate,
  onApplyMaintenance,
  onStage,
  canStage = false,
  isStagedByQueue = false,
  onUpdateIngestCapture,
}: ReviewItemCardProps) {
  const capabilities = getReviewCapabilities({
    kind: item.kind,
    status: item.status,
    suggestionKind: item.suggestionKind,
    hasGeneratedSuggestion: item.proposed !== undefined || suggestions[item.id] !== undefined,
  });
  const isPending = item.inFlight !== null;
  const lastFailure = item.failures.approve ?? item.failures.apply ?? item.failures.reject;

  const isGenerating = generating.has(item.id);
  const suggestion = suggestions[item.id];
  const suggestionProvenance = provenances[item.id];
  const hasSuggestionKind = item.suggestionKind != null;
  const generateLabel = item.suggestionKind ? (GENERATE_LABELS[item.suggestionKind] ?? "Generate Suggestion") : null;
  const needsDiffPreview = item.suggestionKind != null && PREVIEWABLE_SUGGESTION_KINDS.has(item.suggestionKind);
  const [diffPreviewOpen, setDiffPreviewOpen] = useState(false);

  // Effective proposed: either from the item itself or from the generated suggestion
  const effectiveProposed = item.proposed ?? suggestion;

  function handleCopy() {
    if (suggestion) {
      void navigator.clipboard.writeText(suggestion);
    }
  }

  return (
    <div
      data-testid="review-queue-item"
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        background: "#fff",
      }}
    >
      <ReviewQueueItemHeader kind={item.kind} status={item.status} gitStaged={item.gitStaged} />

      <div style={{ fontWeight: 600, fontSize: 14, color: "#1e293b" }}>{item.title}</div>

      <ReviewQueuePreview original={item.original} proposed={effectiveProposed} reason={item.reason} />

      {needsDiffPreview && suggestion && diffPreviewOpen && (
        <div style={{ display: "flex", gap: 8 }}>
          <DiffBlock label="이전" value={item.original ?? ""} tone="remove" />
          <DiffBlock label="이후" value={suggestion} tone="add" />
        </div>
      )}

      {item.kind === "proposed_edit" && <ProvenanceBlock provenance={item.provenance} />}
      {item.kind === "ingest_capture" && (
        <IngestQueueReviewControls item={item} onUpdate={onUpdateIngestCapture} />
      )}
      {suggestion && suggestionProvenance && <ProvenanceBlock provenance={suggestionProvenance} />}

      <div style={{ display: "flex", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
        {/* Generate suggestion button for health items */}
        {hasSuggestionKind && !suggestion && (
          <ActionButton
            variant={isGenerating ? "disabled" : "approve"}
            onClick={!isGenerating && onGenerate ? () => void onGenerate(item.id) : undefined}
            disabled={isGenerating}
          >
            {isGenerating ? "⏳ 생성 중…" : generateLabel}
          </ActionButton>
        )}

        {/* Post-generation actions for health items */}
        {suggestion && hasSuggestionKind && (
          <>
            {needsDiffPreview && !diffPreviewOpen && (
              <ActionButton variant="approve" onClick={() => setDiffPreviewOpen(true)}>
                Preview Diff
              </ActionButton>
            )}
            {(item.kind === "missing_summary" || (needsDiffPreview && diffPreviewOpen)) && onApplyMaintenance ? (
              <ActionButton variant="apply" onClick={() => void onApplyMaintenance(item.id)}>
                Apply to Note
              </ActionButton>
            ) : !needsDiffPreview ? (
              <ActionButton variant="approve" onClick={handleCopy}>
                Copy
              </ActionButton>
            ) : null}
          </>
        )}

        {/* Standard queue actions — driven by state-machine capabilities */}
        {capabilities.approve && (
          <ActionButton variant={isPending ? "disabled" : "approve"} disabled={isPending} onClick={!isPending ? () => void onApprove(item.id) : undefined}>
            Approve
          </ActionButton>
        )}
        {capabilities.apply && (
          <ActionButton variant={isPending ? "disabled" : "apply"} disabled={isPending} onClick={!isPending ? () => void onApply(item.id) : undefined}>
            Apply
          </ActionButton>
        )}
        {capabilities.reject && (
          <ActionButton variant={isPending ? "disabled" : "reject"} disabled={isPending} onClick={!isPending ? () => void onReject(item.id) : undefined}>
            Reject
          </ActionButton>
        )}
        {canStage && onStage && (
          <ActionButton
            variant={isStagedByQueue || isPending ? "disabled" : "approve"}
            disabled={isStagedByQueue || isPending}
            onClick={!isStagedByQueue && !isPending ? () => void onStage(item.id) : undefined}
          >
            {isStagedByQueue ? "Staged" : "Stage"}
          </ActionButton>
        )}
        {item.status === "applied" && !capabilities.apply && (
          <ActionButton variant="disabled" disabled>Applied</ActionButton>
        )}
        {item.status === "committed" && (
          <ActionButton variant="disabled" disabled>Committed</ActionButton>
        )}
        {item.status === "rejected" && (
          <ActionButton variant="disabled" disabled>Rejected</ActionButton>
        )}
        {lastFailure && (
          <span style={{ fontSize: 11, color: "#dc2626", alignSelf: "center" }}>
            {lastFailure.message}
          </span>
        )}
      </div>
    </div>
  );
}
