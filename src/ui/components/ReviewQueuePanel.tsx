import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { ReviewQueueItem, ReviewItemStatus } from "../../api/types";

interface ReviewQueuePanelProps {
  items: ReviewQueueItem[];
  onApply: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
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

const STATUS_COLORS: Record<ReviewItemStatus, { bg: string; color: string }> = {
  new: { bg: "#dbeafe", color: "#1d4ed8" },
  drafted: { bg: "#e0e7ff", color: "#4338ca" },
  approved: { bg: "#d1fae5", color: "#065f46" },
  applied: { bg: "#f0fdf4", color: "#166534" },
  committed: { bg: "#ecfdf5", color: "#14532d" },
  rejected: { bg: "#fee2e2", color: "#991b1b" },
};

const FILTER_TABS: Array<ReviewItemStatus | "all"> = [
  "all", "new", "drafted", "approved", "applied", "rejected",
];

export function ReviewQueuePanel({ items, onApply, onApprove, onReject }: ReviewQueuePanelProps) {
  const [filter, setFilter] = useState<ReviewItemStatus | "all">("all");

  const pendingCount = items.filter(
    (i) => i.status === "new" || i.status === "drafted"
  ).length;

  const filtered =
    filter === "all" ? items : items.filter((i) => i.status === filter);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>
      {/* Header */}
      <div
        style={{
          padding: "12px 16px 8px 16px",
          borderBottom: "1px solid #cbd5e1",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 15 }}>Review Queue</span>
        <span
          style={{
            background: "#dbeafe",
            color: "#1d4ed8",
            borderRadius: 10,
            padding: "1px 8px",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {pendingCount}
        </span>
      </div>

      {/* Filter tabs */}
      <div
        className="distillTabHeader"
        style={{ padding: "8px 16px", borderBottom: "1px solid #cbd5e1", display: "flex", gap: 4, flexWrap: "wrap" }}
      >
        {FILTER_TABS.map((tab) => (
          <button
            key={tab}
            className={filter === tab ? "active" : ""}
            onClick={() => setFilter(tab)}
            style={{ textTransform: "capitalize", fontSize: 12, padding: "2px 10px" }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Items */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        {filtered.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#94a3b8",
              fontSize: 14,
              padding: "48px 0",
            }}
          >
            검토할 항목이 없습니다
          </div>
        ) : (
          filtered.map((item) => <ReviewItemCard key={item.id} item={item} onApply={onApply} onApprove={onApprove} onReject={onReject} />)
        )}
      </div>
    </div>
  );
}

interface ReviewItemCardProps {
  item: ReviewQueueItem;
  onApply: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

function ReviewItemCard({ item, onApply, onApprove, onReject }: ReviewItemCardProps) {
  const kindColor = KIND_COLORS[item.kind] ?? "#64748b";
  const statusStyle = STATUS_COLORS[item.status] ?? { bg: "#f1f5f9", color: "#475569" };

  return (
    <div
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
      {/* Top row: badges */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {/* Kind badge */}
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
        {/* Status badge */}
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
        {/* Staged badge */}
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
            ⬡ staged
          </span>
        )}
      </div>

      {/* Title */}
      <div style={{ fontWeight: 600, fontSize: 14, color: "#1e293b" }}>{item.title}</div>

      {/* Diff or proposed block */}
      {item.original != null ? (
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>이전</div>
            <pre
              style={{
                margin: 0,
                padding: "8px 10px",
                background: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: 4,
                fontSize: 12,
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "#7f1d1d",
              }}
            >
              {item.original}
            </pre>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>이후</div>
            <pre
              style={{
                margin: 0,
                padding: "8px 10px",
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderRadius: 4,
                fontSize: 12,
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "#14532d",
              }}
            >
              {item.proposed ?? ""}
            </pre>
          </div>
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

      {/* Reason */}
      {item.reason && (
        <div style={{ fontSize: 13, color: "#64748b", fontStyle: "italic" }}>{item.reason}</div>
      )}

      {/* Action bar */}
      <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
        {(item.status === "new" || item.status === "drafted") && (
          <>
            <ActionButton variant="approve" onClick={() => onApprove(item.id)}>Approve</ActionButton>
            <ActionButton variant="apply" onClick={() => onApply(item.id)}>Apply</ActionButton>
            <ActionButton variant="reject" onClick={() => onReject(item.id)}>Reject</ActionButton>
          </>
        )}
        {item.status === "approved" && (
          <>
            <ActionButton variant="apply" onClick={() => onApply(item.id)}>Apply</ActionButton>
            <ActionButton variant="reject" onClick={() => onReject(item.id)}>Reject</ActionButton>
          </>
        )}
        {(item.status === "applied" || item.status === "committed") && (
          <ActionButton variant="disabled" disabled>Applied ✓</ActionButton>
        )}
        {item.status === "rejected" && (
          <ActionButton variant="disabled" disabled>Rejected</ActionButton>
        )}
      </div>
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

interface ActionButtonProps {
  variant: ActionVariant;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}

function ActionButton({ variant, onClick, disabled, children }: ActionButtonProps) {
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
