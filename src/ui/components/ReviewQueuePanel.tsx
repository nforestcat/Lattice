import { useState } from "react";
import type { AiProvenance, ReviewQueueItem, ReviewItemStatus } from "../../api/types";
import { ReviewQueueItemCard } from "./ReviewQueueItemCard";

interface ReviewQueuePanelProps {
  readonly items: ReviewQueueItem[];
  readonly onApply: (id: string) => void | Promise<void>;
  readonly onApprove: (id: string) => void | Promise<void>;
  readonly onReject: (id: string) => void | Promise<void>;
  readonly generating?: Set<string>;
  readonly suggestions?: Record<string, string>;
  readonly provenances?: Record<string, AiProvenance>;
  readonly onGenerate?: (id: string) => void | Promise<void>;
  readonly onApplyMaintenance?: (id: string) => void | Promise<void>;
  readonly onStage?: (id: string) => void | Promise<void>;
  readonly canStageItem?: (id: string) => boolean;
  readonly stagedByQueue?: Set<string>;
}

const FILTER_TABS: Array<ReviewItemStatus | "all"> = [
  "all", "new", "drafted", "approved", "applied", "rejected",
];

export function ReviewQueuePanel({
  items,
  onApply,
  onApprove,
  onReject,
  generating,
  suggestions,
  provenances,
  onGenerate,
  onApplyMaintenance,
  onStage,
  canStageItem,
  stagedByQueue,
}: ReviewQueuePanelProps) {
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
          filtered.map((item) => (
            <ReviewQueueItemCard
              key={item.id}
              item={item}
              onApply={onApply}
              onApprove={onApprove}
              onReject={onReject}
              generating={generating}
              suggestions={suggestions}
              provenances={provenances}
              onGenerate={onGenerate}
              onApplyMaintenance={onApplyMaintenance}
              onStage={onStage}
              canStage={canStageItem ? canStageItem(item.id) : false}
              isStagedByQueue={stagedByQueue?.has(item.id) ?? false}
            />
          ))
        )}
      </div>
    </div>
  );
}
