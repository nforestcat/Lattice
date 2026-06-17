import type { AiProvenance, IngestQueueUpdate, ReviewItemStatus, ReviewQueueItem } from "../../api/types";
import { IngestQueueReviewControls } from "./reviewQueue/IngestQueueReviewControls";
import { ActionButton } from "./reviewQueue/ReviewQueueActionButton";
import { DiffBlock, ProvenanceBlock } from "./reviewQueue/ReviewQueueBlocks";

type QueueActionHandler = (id: string) => void | Promise<void>;

interface ReviewItemCardProps {
  readonly item: ReviewQueueItem;
  readonly onApply: QueueActionHandler;
  readonly onApprove: QueueActionHandler;
  readonly onReject: QueueActionHandler;
  readonly generating?: Set<string>;
  readonly suggestions?: Record<string, string>;
  readonly provenances?: Record<string, AiProvenance>;
  readonly onGenerate?: (id: string) => void | Promise<void>;
  readonly onApplyMaintenance?: (id: string) => void | Promise<void>;
  readonly onUpdateIngestCapture?: (id: string, patch: IngestQueueUpdate) => void;
}

const KIND_COLORS: Record<string, string> = {
  inbox_capture: "#6366f1",
  ingest_capture: "#0284c7",
  ingest_draft: "#0ea5e9",
  proposed_edit: "#f59e0b",
  missing_summary: "#8b5cf6",
  dead_link: "#ef4444",
  backlink_suggestion: "#10b981",
  duplicate_warning: "#f97316",
  orphan_note: "#64748b",
  stale_note: "#a16207",
  too_broad: "#f59e0b",
  weak_backlinks: "#0d9488",
};

const STATUS_COLORS: Record<ReviewItemStatus, { readonly bg: string; readonly color: string }> = {
  new: { bg: "#dbeafe", color: "#1d4ed8" },
  drafted: { bg: "#e0e7ff", color: "#4338ca" },
  approved: { bg: "#d1fae5", color: "#065f46" },
  applied: { bg: "#f0fdf4", color: "#166534" },
  committed: { bg: "#ecfdf5", color: "#14532d" },
  rejected: { bg: "#fee2e2", color: "#991b1b" },
};

const GENERATE_LABELS: Record<string, string> = {
  summary: "Generate Summary",
  split: "Suggest Split",
  link_candidates: "Find Link Candidates",
  review_prompt: "Suggest Review",
  merge_or_delete: "Suggest Merge/Delete",
  backlinks_in: "Find Inbound Links",
};

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
  onUpdateIngestCapture,
}: ReviewItemCardProps) {
  const kindColor = KIND_COLORS[item.kind] ?? "#64748b";
  const statusStyle = STATUS_COLORS[item.status];
  const canApply = item.kind === "inbox_capture" || item.kind === "proposed_edit" || item.kind === "backlink_suggestion" || item.kind === "ingest_capture";
  const canApprove = item.kind === "ingest_draft" || item.kind === "proposed_edit" || item.kind === "ingest_capture";

  const isGenerating = generating.has(item.id);
  const suggestion = suggestions[item.id];
  const suggestionProvenance = provenances[item.id];
  const hasSuggestionKind = item.suggestionKind != null;
  const generateLabel = item.suggestionKind ? (GENERATE_LABELS[item.suggestionKind] ?? "Generate Suggestion") : null;

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
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span
          style={{
            background: kindColor,
            color: "#fff",
            borderRadius: 4,
            padding: "1px 7px",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.02em",
          }}
        >
          {item.kind.replace(/_/g, " ")}
        </span>
        <span
          style={{
            background: statusStyle.bg,
            color: statusStyle.color,
            borderRadius: 4,
            padding: "1px 7px",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {item.status}
        </span>
        {item.gitStaged && (
          <span
            style={{
              background: "#f0fdf4",
              color: "#166534",
              border: "1px solid #bbf7d0",
              borderRadius: 4,
              padding: "1px 7px",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            staged
          </span>
        )}
      </div>

      <div style={{ fontWeight: 600, fontSize: 14, color: "#1e293b" }}>{item.title}</div>

      {item.original != null ? (
        <div style={{ display: "flex", gap: 8 }}>
          <DiffBlock label="이전" value={item.original} tone="remove" />
          <DiffBlock label="이후" value={effectiveProposed ?? ""} tone="add" />
        </div>
      ) : effectiveProposed != null ? (
        <div>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>제안</div>
          <pre
            style={{
              margin: 0,
              padding: "8px 10px",
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: 4,
              fontSize: 12,
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "#1e293b",
            }}
          >
            {effectiveProposed}
          </pre>
        </div>
      ) : null}

      {item.reason && <div style={{ fontSize: 13, color: "#64748b", fontStyle: "italic" }}>{item.reason}</div>}

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
            {item.kind === "missing_summary" && onApplyMaintenance ? (
              <ActionButton variant="apply" onClick={() => void onApplyMaintenance(item.id)}>
                Apply to Note
              </ActionButton>
            ) : (
              <ActionButton variant="approve" onClick={handleCopy}>
                Copy
              </ActionButton>
            )}
          </>
        )}

        {/* Standard queue actions */}
        {(item.status === "new" || item.status === "drafted") && (
          <>
            {canApprove && (
              <ActionButton variant="approve" onClick={() => void onApprove(item.id)}>
                Approve
              </ActionButton>
            )}
            {canApply && (
              <ActionButton variant="apply" onClick={() => void onApply(item.id)}>
                Apply
              </ActionButton>
            )}
            <ActionButton variant="reject" onClick={() => void onReject(item.id)}>
              Reject
            </ActionButton>
          </>
        )}
        {item.status === "approved" && (
          <>
            {canApply && (
              <ActionButton variant="apply" onClick={() => void onApply(item.id)}>
                Apply
              </ActionButton>
            )}
            <ActionButton variant="reject" onClick={() => void onReject(item.id)}>
              Reject
            </ActionButton>
          </>
        )}
        {(item.status === "applied" || item.status === "committed") && (
          <ActionButton variant="disabled" disabled>
            Applied
          </ActionButton>
        )}
        {item.status === "rejected" && (
          <ActionButton variant="disabled" disabled>
            Rejected
          </ActionButton>
        )}
      </div>
    </div>
  );
}
