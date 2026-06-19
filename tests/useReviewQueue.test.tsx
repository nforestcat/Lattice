import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InboxCaptureBlock } from "../src/core/capture";
import type { ProposedEdit, StubDraftReview } from "../src/api/types";
import {
  useReviewQueue,
  type ReviewQueueSources,
} from "../src/ui/hooks/useReviewQueue";

const capture: InboxCaptureBlock = {
  id: "capture-1",
  title: "2026-06-18 09:00",
  body: "Captured text",
  markdown: "Captured text",
  relatedTitle: "Inbox.md",
};

function sources(
  overrides: Partial<ReviewQueueSources> = {}
): ReviewQueueSources {
  return {
    inboxCaptures: [capture],
    bulkDrafts: {},
    proposedEdits: [],
    healthReports: [],
    backlinkSuggestions: [],
    ingestItems: [],
    ...overrides,
  };
}

describe("useReviewQueue", () => {
  it("keeps an item new when apply reports no mutation", async () => {
    // Given: applying a capture reports that no file changed.
    const { result } = renderHook(() =>
      useReviewQueue(sources({ onApplyInboxCapture: () => false }))
    );

    // When: the capture is applied.
    await act(async () => {
      expect(await result.current.applyItem("capture-1")).toEqual([]);
    });

    // Then: the queue does not claim the capture was applied.
    expect(result.current.items[0]?.status).toBe("new");
  });

  it("returns exact mutated paths and marks the item applied", async () => {
    // Given: applying a capture mutates Inbox.md.
    const apply = vi.fn().mockResolvedValue(["Inbox.md"]);
    const { result } = renderHook(() =>
      useReviewQueue(sources({ onApplyInboxCapture: apply }))
    );

    // When: the capture is applied.
    await act(async () => {
      expect(await result.current.applyItem("capture-1")).toEqual(["Inbox.md"]);
    });

    // Then: the exact path and applied state are exposed.
    expect(apply).toHaveBeenCalledWith("capture-1");
    expect(result.current.items[0]?.status).toBe("applied");
  });

  it("sorts active items before completed items and filters by kind and status", () => {
    // Given: captures have different timestamps and an applied edit is completed.
    const olderCapture: InboxCaptureBlock = {
      ...capture,
      id: "capture-old",
      title: "2026-06-17 09:00",
    };
    const newerCapture: InboxCaptureBlock = {
      ...capture,
      id: "capture-new",
      title: "2026-06-19 09:00",
    };
    const appliedEdit: ProposedEdit = {
      id: "edit-1",
      type: "update",
      path: "Done.md",
      targetContent: "before",
      replacementContent: "after",
      applied: true,
    };
    const { result } = renderHook(() =>
      useReviewQueue(
        sources({
          inboxCaptures: [olderCapture, newerCapture],
          proposedEdits: [appliedEdit],
        })
      )
    );

    // When: the full queue and an active capture filter are read.
    const filtered = result.current.filterItems("inbox_capture", "new");

    // Then: active captures are newest-first and precede the completed edit.
    expect(result.current.items.map((item) => item.id)).toEqual([
      "capture-new",
      "capture-old",
      "edit-1",
    ]);
    expect(filtered.map((item) => item.id)).toEqual([
      "capture-new",
      "capture-old",
    ]);
  });

  it("approves a draft after its approval callback succeeds", async () => {
    // Given: a drafted stub has an approval callback.
    const draft: StubDraftReview = {
      content: "# Draft",
      status: "drafting",
      approved: false,
    };
    const approve = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() =>
      useReviewQueue(
        sources({
          inboxCaptures: [],
          bulkDrafts: { "Draft.md": draft },
          onApproveStubDraft: approve,
        })
      )
    );

    // When: the draft is approved.
    await act(async () => {
      await result.current.approveItem("stub-Draft.md");
    });

    // Then: the source callback receives the target and the item transitions.
    expect(approve).toHaveBeenCalledWith("Draft.md");
    expect(result.current.items[0]?.status).toBe("approved");
  });

  it("keeps a draft unchanged when its rejection callback declines", async () => {
    // Given: a drafted stub has a rejection callback that declines the action.
    const draft: StubDraftReview = {
      content: "# Draft",
      status: "drafting",
      approved: false,
    };
    const reject = vi.fn().mockResolvedValue(false);
    const { result } = renderHook(() =>
      useReviewQueue(
        sources({
          inboxCaptures: [],
          bulkDrafts: { "Draft.md": draft },
          onRejectStubDraft: reject,
        })
      )
    );

    // When: rejection is requested.
    await act(async () => {
      await result.current.rejectItem("stub-Draft.md");
    });

    // Then: the source is called but the queue status remains drafted.
    expect(reject).toHaveBeenCalledWith("Draft.md");
    expect(result.current.items[0]?.status).toBe("drafted");
  });

  it("prunes a local status override after its source item disappears", async () => {
    // Given: an applied capture has a local applied override.
    const { result, rerender } = renderHook(
      ({ currentSources }: { currentSources: ReviewQueueSources }) =>
        useReviewQueue(currentSources),
      {
        initialProps: {
          currentSources: sources({
            onApplyInboxCapture: () => ["Inbox.md"],
          }),
        },
      }
    );
    await act(async () => {
      await result.current.applyItem("capture-1");
    });
    expect(result.current.items[0]?.status).toBe("applied");

    // When: the source disappears and later returns.
    rerender({ currentSources: sources({ inboxCaptures: [] }) });
    await waitFor(() => {
      expect(result.current.items).toEqual([]);
    });
    rerender({ currentSources: sources() });

    // Then: the reintroduced source starts from its base status.
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe("new");
    });
  });

  it("exposes staged queue items through the commit bundle", () => {
    // Given: only Inbox.md is staged in git.
    const { result } = renderHook(() =>
      useReviewQueue(
        sources({
          gitStagedPaths: new Set(["Inbox.md"]),
        })
      )
    );

    // When: the hook's commit bundle is read.
    const bundle = result.current.commitBundle;

    // Then: the staged item is projected and counted by kind.
    expect(bundle.isEmpty).toBe(false);
    expect(bundle.items).toEqual([
      {
        id: "capture-1",
        kind: "inbox_capture",
        title: "2026-06-18 09:00",
        path: "Inbox.md",
        status: "new",
        createdAt: Date.parse("2026-06-18T09:00:00"),
      },
    ]);
    expect(bundle.countByKind).toEqual({ inbox_capture: 1 });
  });
});
