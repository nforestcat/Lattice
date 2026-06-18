import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InboxCaptureBlock } from "../src/core/capture";
import { useReviewQueue } from "../src/ui/hooks/useReviewQueue";

const capture: InboxCaptureBlock = {
  id: "capture-1",
  title: "2026-06-18 09:00",
  body: "Captured text",
  markdown: "Captured text",
  relatedTitle: "Inbox.md",
};

function sources(onApplyInboxCapture: (id: string) => readonly string[] | false | Promise<readonly string[] | false>) {
  return {
    inboxCaptures: [capture],
    bulkDrafts: {},
    proposedEdits: [],
    healthReports: [],
    backlinkSuggestions: [],
    ingestItems: [],
    onApplyInboxCapture,
  };
}

describe("useReviewQueue", () => {
  it("keeps an item new when apply reports no mutation", async () => {
    const { result } = renderHook(() => useReviewQueue(sources(() => false)));
    await act(async () => {
      expect(await result.current.applyItem("capture-1")).toEqual([]);
    });
    expect(result.current.items[0]?.status).toBe("new");
  });

  it("returns exact mutated paths and marks the item applied", async () => {
    const apply = vi.fn().mockResolvedValue(["Inbox.md"]);
    const { result } = renderHook(() => useReviewQueue(sources(apply)));
    await act(async () => {
      expect(await result.current.applyItem("capture-1")).toEqual(["Inbox.md"]);
    });
    expect(result.current.items[0]?.status).toBe("applied");
  });
});
