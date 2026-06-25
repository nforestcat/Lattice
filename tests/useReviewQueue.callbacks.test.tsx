import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useReviewQueue,
  type ReviewQueueSources,
} from "../src/ui/hooks/useReviewQueue";
import { stubSources } from "./reviewWorkflow/reviewQueueFixtures";

describe("useReviewQueue callback freshness", () => {
  it("uses callbacks supplied by the latest rerender for subsequent operations", async () => {
    // Given
    const initialApprove = vi.fn().mockResolvedValue(false);
    const currentApprove = vi.fn().mockResolvedValue(true);
    const { result, rerender } = renderHook(
      ({ currentSources }: { currentSources: ReviewQueueSources }) =>
        useReviewQueue(currentSources),
      {
        initialProps: {
          currentSources: stubSources({
            onApproveStubDraft: initialApprove,
          }),
        },
      }
    );
    await act(async () => {
      expect(await result.current.approveItem("stub-Draft.md")).toMatchObject({
        ok: false,
        code: "declined",
      });
    });

    // When
    rerender({
      currentSources: stubSources({
        onApproveStubDraft: currentApprove,
      }),
    });
    await act(async () => {
      expect(await result.current.approveItem("stub-Draft.md")).toMatchObject({
        ok: true,
        status: "approved",
      });
    });

    // Then
    expect(initialApprove).toHaveBeenCalledTimes(1);
    expect(currentApprove).toHaveBeenCalledTimes(1);
    expect(result.current.items[0]?.attempts.approve).toBe(2);
  });
});
