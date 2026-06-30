import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReviewActionResult } from "../src/ui/reviewWorkflow/contracts";
import {
  deferred,
  renderQueue,
  stubSources,
} from "./reviewWorkflow/reviewQueueFixtures";

describe("useReviewQueue concurrency", () => {
  it("shares an identical in-flight approval promise", async () => {
    // Given
    const approval = deferred<boolean>();
    const approve = vi.fn(() => approval.promise);
    const { result } = renderQueue(
      stubSources({ onApproveStubDraft: approve })
    );

    // When
    let first: Promise<ReviewActionResult> | undefined;
    let second: Promise<ReviewActionResult> | undefined;
    act(() => {
      first = result.current.approveItem("stub-Draft.md");
      second = result.current.approveItem("stub-Draft.md");
    });

    // Then
    expect(second).toBe(first);
    approval.resolve(true);
    await act(async () => {
      await first;
    });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(result.current.items[0]?.attempts.approve).toBe(1);
  });

  it("returns busy for approve-versus-reject and approve-versus-apply", async () => {
    // Given
    const approval = deferred<boolean>();
    const reject = vi.fn().mockResolvedValue(true);
    const apply = vi.fn().mockResolvedValue({
      changedPaths: ["Draft.md"],
      warnings: [],
    });
    const { result } = renderQueue(
      stubSources({
        onApproveStubDraft: () => approval.promise,
        onRejectStubDraft: reject,
      })
    );

    // When
    let rejection: ReviewActionResult | undefined;
    let application: ReviewActionResult | undefined;
    await act(async () => {
      const pending = result.current.approveItem("stub-Draft.md");
      rejection = await result.current.rejectItem("stub-Draft.md");
      application = await result.current.applyItem("stub-Draft.md", apply);
      approval.resolve(true);
      await pending;
    });

    // Then
    expect(rejection).toMatchObject({ ok: false, code: "busy" });
    expect(application).toMatchObject({ ok: false, code: "busy" });
    expect(reject).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("deduplicates immediate sequential approval from the ref ledger", async () => {
    // Given
    const approve = vi.fn().mockResolvedValue(true);
    const { result } = renderQueue(
      stubSources({ onApproveStubDraft: approve })
    );

    // When
    let repeated: ReviewActionResult | undefined;
    await act(async () => {
      await result.current.approveItem("stub-Draft.md");
      repeated = await result.current.approveItem("stub-Draft.md");
    });

    // Then
    expect(repeated).toEqual({
      ok: true,
      operation: "approve",
      itemId: "stub-Draft.md",
      status: "approved",
      deduplicated: true,
    });
    expect(approve).toHaveBeenCalledTimes(1);
  });
});
