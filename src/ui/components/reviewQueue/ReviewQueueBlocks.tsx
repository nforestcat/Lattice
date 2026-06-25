import type { AiProvenance, ReviewItemStatus } from "../../../api/types";

type ReviewQueueItemHeaderProps = {
  readonly kind: string;
  readonly status: ReviewItemStatus;
  readonly gitStaged?: boolean;
};

type ReviewQueuePreviewProps = {
  readonly original?: string;
  readonly proposed?: string;
  readonly reason?: string;
};

const KIND_COLORS: Readonly<Record<string, string>> = {
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

const STATUS_COLORS: Readonly<Record<ReviewItemStatus, { readonly bg: string; readonly color: string }>> = {
  drafted: { bg: "#e0e7ff", color: "#4338ca" },
  approved: { bg: "#d1fae5", color: "#065f46" },
  applied: { bg: "#f0fdf4", color: "#166534" },
  committed: { bg: "#ecfdf5", color: "#14532d" },
  rejected: { bg: "#fee2e2", color: "#991b1b" },
};

export function ReviewQueueItemHeader({ kind, status, gitStaged }: ReviewQueueItemHeaderProps) {
  const statusStyle = STATUS_COLORS[status];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span
        style={{
          background: KIND_COLORS[kind] ?? "#64748b",
          color: "#fff",
          borderRadius: 4,
          padding: "1px 7px",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.02em",
        }}
      >
        {kind.replace(/_/g, " ")}
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
        {status}
      </span>
      {gitStaged && (
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
  );
}

export function ReviewQueuePreview({ original, proposed, reason }: ReviewQueuePreviewProps) {
  return (
    <>
      {original != null ? (
        <div style={{ display: "flex", gap: 8 }}>
          <DiffBlock label="이전" value={original} tone="remove" />
          <DiffBlock label="이후" value={proposed ?? ""} tone="add" />
        </div>
      ) : proposed != null ? (
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
            {proposed}
          </pre>
        </div>
      ) : null}
      {reason && <div style={{ fontSize: 13, color: "#64748b", fontStyle: "italic" }}>{reason}</div>}
    </>
  );
}

export function ProvenanceBlock({ provenance }: { readonly provenance?: AiProvenance }) {
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
          원문: {provenance.originalExcerpt.slice(0, 80)}{provenance.originalExcerpt.length > 80 ? "..." : ""}
        </span>
      )}
    </div>
  );
}

export function DiffBlock({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone: "add" | "remove";
}) {
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
