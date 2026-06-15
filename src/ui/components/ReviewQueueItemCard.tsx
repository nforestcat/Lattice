import type { CSSProperties, ReactNode } from "react";
import type { AiProvenance, ReviewItemStatus, ReviewQueueItem } from "../../api/types";

type QueueActionHandler = (id: string) => void | Promise<void>;

interface ReviewItemCardProps {
  readonly item: ReviewQueueItem;
  readonly onApply: QueueActionHandler;
  readonly onApprove: QueueActionHandler;
  readonly onReject: QueueActionHandler;
}

const KIND_COLORS: Record<string, string> = {
  inbox_capture: "#6366f1",
  ingest_draft: "#0ea5e9",
  proposed_edit: "#f59e0b",
  missing_summary: "#8b5cf6",
  dead_link: "#ef4444",
  backlink_suggestion: "#10b981",
  duplicate_warning: "#f97316",
  orphan_note: "#64748b",
  stale_note: "#a16207",
};

const STATUS_COLORS: Record<ReviewItemStatus, { readonly bg: string; readonly color: string }> = {
  new: { bg: "#dbeafe", color: "#1d4ed8" },
  drafted: { bg: "#e0e7ff", color: "#4338ca" },
  approved: { bg: "#d1fae5", color: "#065f46" },
  applied: { bg: "#f0fdf4", color: "#166534" },
  committed: { bg: "#ecfdf5", color: "#14532d" },
  rejected: { bg: "#fee2e2", color: "#991b1b" },
};

export function ReviewQueueItemCard({ item, onApply, onApprove, onReject }: ReviewItemCardProps) {
  const kindColor = KIND_COLORS[item.kind] ?? "#64748b";
  const statusStyle = STATUS_COLORS[item.status];
  const canApply = item.kind === "inbox_capture" || item.kind === "proposed_edit" || item.kind === "backlink_suggestion";
  const canApprove = item.kind === "ingest_draft" || item.kind === "proposed_edit";

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
          <DiffBlock label="이후" value={item.proposed ?? ""} tone="add" />
        </div>
      ) : item.proposed != null ? (
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
            {item.proposed}
          </pre>
        </div>
      ) : null}

      {item.reason && <div style={{ fontSize: 13, color: "#64748b", fontStyle: "italic" }}>{item.reason}</div>}

      {item.kind === "proposed_edit" && <ProvenanceBlock provenance={item.provenance} />}

      <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
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

function ProvenanceBlock({ provenance }: { readonly provenance?: AiProvenance }) {
  if (provenance === undefined) {
    return (
      <div style={{ fontSize: 11, color: "#94a3b8", padding: "4px 8px", background: "#f8fafc", borderRadius: 4, border: "1px solid #e2e8f0" }}>
        출처 없음 (no provenance recorded)
      </div>
    );
  }

  const isUnlinked = provenance.promptRunId === null;

  return (
    <div style={{ fontSize: 11, color: "#475569", padding: "6px 10px", background: "#f8fafc", borderRadius: 4, border: "1px solid #e2e8f0", display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
      {isUnlinked && (
        <span style={{ background: "#fef3c7", color: "#92400e", borderRadius: 3, padding: "1px 6px", fontWeight: 600 }}>
          unlinked prompt
        </span>
      )}
      <span><b>출처:</b> {provenance.source}</span>
      {provenance.model && <span><b>모델:</b> {provenance.model}</span>}
      {provenance.confidence !== undefined && <span><b>신뢰도:</b> {(provenance.confidence * 100).toFixed(0)}%</span>}
      {provenance.appliedAt && <span><b>적용:</b> {new Date(provenance.appliedAt).toLocaleString()}</span>}
      {provenance.originalExcerpt && (
        <span style={{ width: "100%", fontStyle: "italic", color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          원문: {provenance.originalExcerpt.slice(0, 80)}{provenance.originalExcerpt.length > 80 ? "…" : ""}
        </span>
      )}
    </div>
  );
}

function DiffBlock({ label, value, tone }: { readonly label: string; readonly value: string; readonly tone: "add" | "remove" }) {
  const styles =
    tone === "add"
      ? { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#14532d" }
      : { background: "#fef2f2", border: "1px solid #fecaca", color: "#7f1d1d" };

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>{label}</div>
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          borderRadius: 4,
          fontSize: 12,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          ...styles,
        }}
      >
        {value}
      </pre>
    </div>
  );
}

type ActionVariant = "approve" | "apply" | "reject" | "disabled";

const ACTION_VARIANT_STYLES: Record<ActionVariant, CSSProperties> = {
  approve: { background: "#d1fae5", color: "#065f46", border: "1px solid #6ee7b7", cursor: "pointer" },
  apply: { background: "#dbeafe", color: "#1d4ed8", border: "1px solid #93c5fd", cursor: "pointer" },
  reject: { background: "#fee2e2", color: "#991b1b", border: "1px solid #fca5a5", cursor: "pointer" },
  disabled: { background: "#f1f5f9", color: "#94a3b8", border: "1px solid #e2e8f0", cursor: "not-allowed" },
};

function ActionButton({
  variant,
  onClick,
  disabled,
  children,
}: {
  readonly variant: ActionVariant;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "3px 12px",
        fontSize: 12,
        borderRadius: 4,
        fontWeight: 600,
        ...ACTION_VARIANT_STYLES[variant],
      }}
    >
      {children}
    </button>
  );
}
