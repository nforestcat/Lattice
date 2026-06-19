import { describe, expect, it } from "vitest";
import type {
  ReviewItemKind,
  ReviewQueueItem,
} from "../src/api/ingestReviewTypes";
import {
  buildAuditLog,
  buildCommitBundle,
} from "../src/ui/hooks/commitBundle";

function queueItem(
  id: string,
  kind: ReviewItemKind,
  createdAt: number,
  gitStaged: boolean
): ReviewQueueItem {
  return {
    id,
    sourceId: id,
    kind,
    status: "approved",
    path: `${id}.md`,
    title: id,
    gitStaged,
    createdAt,
  };
}

describe("buildCommitBundle", () => {
  it("includes only staged items and counts each included kind", () => {
    // Given: two staged items and one unstaged item.
    const items = [
      queueItem("inbox-1", "inbox_capture", 1, true),
      queueItem("inbox-2", "inbox_capture", 2, false),
      queueItem("edit-1", "proposed_edit", 3, true),
    ];

    // When: a commit bundle is built.
    const result = buildCommitBundle(items);

    // Then: only staged projections are included and counted.
    expect(result.items.map((item) => item.id)).toEqual([
      "inbox-1",
      "edit-1",
    ]);
    expect(result.countByKind).toEqual({
      inbox_capture: 1,
      proposed_edit: 1,
    });
    expect(result.isEmpty).toBe(false);
  });

  it("returns an empty bundle when no queue item is staged", () => {
    // Given: the queue has only unstaged items.
    const items = [queueItem("inbox-1", "inbox_capture", 1, false)];

    // When: a commit bundle is built.
    const result = buildCommitBundle(items);

    // Then: the bundle explicitly reports that it is empty.
    expect(result).toEqual({
      items: [],
      countByKind: {},
      isEmpty: true,
    });
  });
});

describe("buildAuditLog", () => {
  it("sorts newest items first without mutating bundle order", () => {
    // Given: a bundle is ordered oldest-first.
    const bundle = buildCommitBundle([
      queueItem("old", "inbox_capture", 1, true),
      queueItem("new", "proposed_edit", 3, true),
      queueItem("middle", "backlink_suggestion", 2, true),
    ]);

    // When: the audit log is built.
    const result = buildAuditLog(bundle);

    // Then: the log is newest-first and the bundle remains unchanged.
    expect(result.map((item) => item.id)).toEqual(["new", "middle", "old"]);
    expect(bundle.items.map((item) => item.id)).toEqual([
      "old",
      "new",
      "middle",
    ]);
  });
});
