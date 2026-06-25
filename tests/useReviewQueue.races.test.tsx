import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  useReviewQueue,
  type ReviewQueueSources,
} from "../src/ui/hooks/useReviewQueue";
import type { ReviewActionResult } from "../src/ui/reviewWorkflow/contracts";
import {
  deferred,
  stubSources,
} from "./reviewWorkflow/reviewQueueFixtures";

describe("useReviewQueue removal races", () => {
  it("does not publish or resurrect a removed item when its operation completes", async () => {
    // Given
    const approval = deferred<boolean>();
    let renderCount = 0;
    const { result, rerender } = renderHook(
      ({ currentSources }: { currentSources: ReviewQueueSources }) => {
        renderCount += 1;
        return useReviewQueue(currentSources);
      },
      {
        initialProps: {
          currentSources: stubSources({
            onApproveStubDraft: () => approval.promise,
          }),
        },
      }
    );
    let pending: Promise<ReviewActionResult> | undefined;
    act(() => {
      pending = result.current.approveItem("stub-Draft.md");
    });
    rerender({ currentSources: stubSources({ bulkDrafts: {} }) });
    const rendersAfterRemoval = renderCount;

    // When
    approval.resolve(true);
    let actionResult: ReviewActionResult | undefined;
    await act(async () => {
      actionResult = await pending;
    });

    // Then
    expect(actionResult).toMatchObject({
      ok: true,
      operation: "approve",
      itemId: "stub-Draft.md",
      status: "approved",
    });
    expect(renderCount).toBe(rendersAfterRemoval);
    expect(result.current.items).toEqual([]);
    rerender({ currentSources: stubSources() });
    expect(result.current.items[0]).toMatchObject({
      status: "drafted",
      attempts: { approve: 0 },
    });
  });

  it("keeps the operation result typed after the hook unmounts", async () => {
    // Given
    const approval = deferred<boolean>();
    const { result, unmount } = renderHook(() =>
      useReviewQueue(
        stubSources({ onApproveStubDraft: () => approval.promise })
      )
    );
    const operation: {
      pending: Promise<ReviewActionResult> | null;
    } = { pending: null };
    act(() => {
      operation.pending = result.current.approveItem("stub-Draft.md");
    });
    unmount();
    if (operation.pending === null) {
      throw new TypeError("Approval operation was not started.");
    }

    // When
    approval.resolve(true);
    const actionResult: ReviewActionResult = await operation.pending;

    // Then
    expect(actionResult).toMatchObject({
      ok: true,
      operation: "approve",
      itemId: "stub-Draft.md",
      status: "approved",
    });
  });
});
