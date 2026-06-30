import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReviewActionResult } from "../src/ui/reviewWorkflow/contracts";
import {
  approveCapture,
  deferred,
  renderQueue,
  sources,
} from "./reviewWorkflow/reviewQueueFixtures";

describe("useReviewQueue apply ledger", () => {
  it("keeps an approved item retryable when zero paths change", async () => {
    // Given
    const { result } = renderQueue(
      sources({
        onApplyInboxCapture: () => ({ changedPaths: [], warnings: [] }),
      })
    );
    await approveCapture(result);

    // When
    let actionResult: ReviewActionResult | undefined;
    await act(async () => {
      actionResult = await result.current.applyItem("capture-1");
    });

    // Then
    expect(actionResult).toMatchObject({
      ok: false,
      operation: "apply",
      code: "failed",
      status: "approved",
    });
    expect(result.current.items[0]?.status).toBe("approved");
    expect(result.current.items[0]?.failures.apply?.code).toBe("failed");
  });

  it("normalizes exact paths and succeeds with partial warnings", async () => {
    // Given
    const warning = {
      code: "partial_failure" as const,
      message: "One backlink target failed.",
      path: "Notes/Missing.md",
    };
    const apply = vi.fn().mockResolvedValue({
      changedPaths: ["./Inbox.md", "Daily\\2026-06-18.md", "Inbox.md"],
      warnings: [warning],
    });
    const { result } = renderQueue(sources({ onApplyInboxCapture: apply }));
    await approveCapture(result);

    // When
    let actionResult: ReviewActionResult | undefined;
    await act(async () => {
      actionResult = await result.current.applyItem("capture-1");
    });

    // Then
    expect(actionResult).toEqual({
      ok: true,
      operation: "apply",
      itemId: "capture-1",
      status: "applied",
      changedPaths: ["Inbox.md", "Daily/2026-06-18.md"],
      warnings: [warning],
      deduplicated: false,
    });
    expect(result.current.items[0]?.warnings).toEqual([warning]);
  });

  it("shares one apply execution and returns cached paths afterward", async () => {
    // Given
    const mutation = deferred<{
      changedPaths: readonly string[];
      warnings: readonly [];
    }>();
    const apply = vi.fn(() => mutation.promise);
    const { result } = renderQueue(sources({ onApplyInboxCapture: apply }));
    await approveCapture(result);

    // When
    let first: Promise<ReviewActionResult> | undefined;
    let second: Promise<ReviewActionResult> | undefined;
    act(() => {
      first = result.current.applyItem("capture-1");
      second = result.current.applyItem("capture-1");
    });

    // Then
    expect(second).toBe(first);
    mutation.resolve({ changedPaths: ["Inbox.md"], warnings: [] });
    await act(async () => {
      await first;
    });
    expect(await result.current.applyItem("capture-1")).toEqual({
      ok: true,
      operation: "apply",
      itemId: "capture-1",
      status: "applied",
      changedPaths: ["Inbox.md"],
      warnings: [],
      deduplicated: true,
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(result.current.items[0]?.attempts.apply).toBe(1);
  });

  it("captures thrown mutation errors and succeeds on retry", async () => {
    // Given
    const apply = vi
      .fn<() => Promise<{ changedPaths: string[]; warnings: [] }>>()
      .mockRejectedValueOnce(new Error("capture mutation failed"))
      .mockResolvedValueOnce({ changedPaths: ["Inbox.md"], warnings: [] });
    const { result } = renderQueue(sources({ onApplyInboxCapture: apply }));
    await approveCapture(result);

    // When
    await act(async () => {
      expect(await result.current.applyItem("capture-1")).toMatchObject({
        ok: false,
        code: "failed",
        status: "approved",
      });
      expect(await result.current.applyItem("capture-1")).toMatchObject({
        ok: true,
        status: "applied",
      });
    });

    // Then
    expect(result.current.items[0]?.attempts.apply).toBe(2);
    expect(result.current.items[0]?.failures.apply).toBeUndefined();
  });
});
