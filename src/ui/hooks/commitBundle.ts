import type { ReviewItemKind, ReviewItemStatus, ReviewQueueItem } from "../../api/ingestReviewTypes";

export const KIND_LABELS: Record<ReviewItemKind, string> = {
  inbox_capture: "Inbox",
  ingest_capture: "Ingest",
  ingest_draft: "Draft",
  proposed_edit: "AI Edit",
  missing_summary: "Health",
  dead_link: "Health",
  backlink_suggestion: "Backlink",
  duplicate_warning: "Health",
  orphan_note: "Health",
  stale_note: "Health",
  too_broad: "Health",
  weak_backlinks: "Health",
};

export type CommitBundleItem = {
  id: string;
  kind: ReviewItemKind;
  title: string;
  path: string;
  status: ReviewItemStatus;
  createdAt: number;
};

export type CommitBundle = {
  items: CommitBundleItem[];
  countByKind: Partial<Record<ReviewItemKind, number>>;
  isEmpty: boolean;
};

export function buildCommitBundle(items: ReviewQueueItem[]): CommitBundle {
  const bundleItems: CommitBundleItem[] = items
    .filter((i) => i.gitStaged)
    .map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      path: i.path,
      status: i.status,
      createdAt: i.createdAt,
    }));

  const countByKind: Partial<Record<ReviewItemKind, number>> = {};
  for (const item of bundleItems) {
    countByKind[item.kind] = (countByKind[item.kind] ?? 0) + 1;
  }

  return { items: bundleItems, countByKind, isEmpty: bundleItems.length === 0 };
}

export function buildAuditLog(bundle: CommitBundle): CommitBundleItem[] {
  return [...bundle.items].sort((a, b) => b.createdAt - a.createdAt);
}
