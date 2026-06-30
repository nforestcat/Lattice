import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProposedEdit } from "../src/api/types";
import type { InboxCaptureBlock } from "../src/core/capture";
import {
  useReviewQueue,
  type ReviewQueueSources,
} from "../src/ui/hooks/useReviewQueue";
import {
  approveCapture,
  capture,
  renderQueue,
  sources,
} from "./reviewWorkflow/reviewQueueFixtures";

describe("useReviewQueue projection", () => {
  it("replaces item projections without mutating a prior returned item", async () => {
    // Given
    const { result } = renderQueue();
    const priorItem = result.current.items[0];

    // When
    await approveCapture(result);

    // Then
    const currentItem = result.current.items[0];
    expect(currentItem).not.toBe(priorItem);
    expect(priorItem).toMatchObject({
      status: "drafted",
      attempts: { approve: 0 },
      inFlight: null,
    });
    expect(currentItem).toMatchObject({
      status: "approved",
      attempts: { approve: 1 },
      inFlight: null,
    });
  });

  it.each(["approved", "applied"] as const)(
    "keeps authoritative local %s state across source rerenders",
    async (expectedStatus) => {
      // Given
      const { result, rerender } = renderHook(
        ({ currentSources }: { currentSources: ReviewQueueSources }) =>
          useReviewQueue(currentSources),
        { initialProps: { currentSources: sources() } }
      );
      await approveCapture(result);
      if (expectedStatus === "applied") {
        await act(async () => {
          await result.current.applyItem("capture-1", () => ({
            changedPaths: ["Inbox.md"],
            warnings: [],
          }));
        });
      }

      // When
      rerender({
        currentSources: sources({
          inboxCaptures: [{ ...capture, title: "2026-06-20 09:00" }],
        }),
      });

      // Then
      expect(result.current.items[0]?.status).toBe(expectedStatus);
      expect(result.current.items[0]?.title).toBe("2026-06-20 09:00");
    }
  );

  it("sorts drafted items first and filters by lifecycle status", () => {
    // Given
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
    const { result } = renderQueue(
      sources({
        inboxCaptures: [olderCapture, newerCapture],
        proposedEdits: [appliedEdit],
      })
    );

    // When
    const filtered = result.current.filterItems("inbox_capture", "drafted");

    // Then
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

  it("prunes ledger state when a source disappears", async () => {
    // Given
    const { result, rerender } = renderHook(
      ({ currentSources }: { currentSources: ReviewQueueSources }) =>
        useReviewQueue(currentSources),
      { initialProps: { currentSources: sources() } }
    );
    await approveCapture(result);

    // When
    rerender({ currentSources: sources({ inboxCaptures: [] }) });
    await waitFor(() => expect(result.current.items).toEqual([]));
    rerender({ currentSources: sources() });

    // Then
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe("drafted");
      expect(result.current.items[0]?.attempts.approve).toBe(0);
    });
  });

  it("exposes staged queue items through the commit bundle", () => {
    // Given
    const { result } = renderQueue(
      sources({ gitStagedPaths: new Set(["Inbox.md"]) })
    );

    // When
    const bundle = result.current.commitBundle;

    // Then
    expect(bundle.items).toEqual([
      {
        id: "capture-1",
        kind: "inbox_capture",
        title: "2026-06-18 09:00",
        path: "Inbox.md",
        status: "drafted",
        createdAt: Date.parse("2026-06-18T09:00:00"),
      },
    ]);
    expect(bundle.countByKind).toEqual({ inbox_capture: 1 });
    expect(bundle.isEmpty).toBe(false);
  });
});
