import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReviewActionResult } from "../src/ui/reviewWorkflow/contracts";
import {
  approveCapture,
  renderQueue,
  sources,
  stubSources,
} from "./reviewWorkflow/reviewQueueFixtures";

describe("useReviewQueue action gates", () => {
  it("returns not_found without invoking an adapter", async () => {
    // Given
    const reject = vi.fn();
    const { result } = renderQueue(
      sources({ onRejectIngestCapture: reject })
    );

    // When
    const actionResult = await result.current.rejectItem("missing");

    // Then
    expect(actionResult).toMatchObject({
      ok: false,
      operation: "reject",
      itemId: null,
      status: null,
      code: "not_found",
    });
    expect(reject).not.toHaveBeenCalled();
  });

  it("blocks unsupported approval without reserving an attempt", async () => {
    // Given
    const { result } = renderQueue(
      sources({
        inboxCaptures: [],
        healthReports: [{
          path: "Duplicate.md",
          title: "Duplicate",
          score: 20,
          issues: [],
          isOrphan: false,
          isStale: false,
          isTooBroad: false,
          isDuplicated: true,
          missingSummary: false,
          weakBacklinks: false,
        }],
      })
    );

    // When
    const actionResult = await result.current.approveItem(
      "health-Duplicate.md-isDuplicated"
    );

    // Then
    expect(actionResult).toMatchObject({
      ok: false,
      operation: "approve",
      code: "unsupported",
      status: "drafted",
    });
    expect(result.current.items[0]?.attempts.approve).toBe(0);
  });

  it("blocks apply-before-approve without invoking its executor", async () => {
    // Given
    const apply = vi.fn().mockResolvedValue({
      changedPaths: ["Inbox.md"],
      warnings: [],
    });
    const { result } = renderQueue(sources({ onApplyInboxCapture: apply }));

    // When
    const actionResult = await result.current.applyItem("capture-1");

    // Then
    expect(actionResult).toMatchObject({
      ok: false,
      operation: "apply",
      code: "invalid_transition",
      status: "drafted",
    });
    expect(apply).not.toHaveBeenCalled();
    expect(result.current.items[0]?.attempts.apply).toBe(0);
  });

  it("applies only approved generated stub drafts when a bulk executor is supplied", async () => {
    // Given
    const applyDraftOne = vi.fn(() => ({
      changedPaths: ["Draft One.md"],
      warnings: [],
    }));
    const applyDraftTwo = vi.fn(() => ({
      changedPaths: ["Draft Two.md"],
      warnings: [],
    }));
    const { result } = renderQueue(
      stubSources({
        bulkDrafts: {
          "Draft One": { content: "# Draft One", status: "done" },
          "Draft Two": { content: "# Draft Two", status: "done" },
        },
      })
    );

    // When
    await act(async () => {
      expect(
        await result.current.applyItem("stub-Draft One", applyDraftOne)
      ).toMatchObject({
        ok: false,
        operation: "apply",
        code: "invalid_transition",
        status: "drafted",
      });
    });
    await act(async () => {
      expect(await result.current.approveItem("stub-Draft One")).toMatchObject({
        ok: true,
        operation: "approve",
        status: "approved",
      });
    });
    const approvedItems = result.current.items.filter(
      (candidate) =>
        candidate.kind === "ingest_draft" &&
        candidate.status === "approved"
    );
    await act(async () => {
      for (const item of approvedItems) {
        const executor =
          item.sourceId === "Draft One" ? applyDraftOne : applyDraftTwo;
        await result.current.applyItem(item.id, executor);
      }
    });

    // Then
    expect(applyDraftOne).toHaveBeenCalledTimes(1);
    expect(applyDraftTwo).not.toHaveBeenCalled();
  });

  it("supports drafted rejection and approved rejection", async () => {
    // Given
    const first = renderQueue();
    const second = renderQueue();
    await approveCapture(second.result);

    // When
    await act(async () => {
      expect(await first.result.current.rejectItem("capture-1")).toMatchObject({
        ok: true,
        operation: "reject",
        status: "rejected",
      });
      expect(await second.result.current.rejectItem("capture-1")).toMatchObject({
        ok: true,
        operation: "reject",
        status: "rejected",
      });
    });

    // Then
    expect(first.result.current.items[0]?.status).toBe("rejected");
    expect(second.result.current.items[0]?.status).toBe("rejected");
  });

  it("rejects approval after an approved item is rejected without reusing cached approval", async () => {
    // Given
    const approve = vi.fn<() => void>();
    const reject = vi.fn<() => void>();
    const { result } = renderQueue(
      stubSources({
        onApproveStubDraft: approve,
        onRejectStubDraft: reject,
      })
    );

    // When
    let repeatedApproval: ReviewActionResult | undefined;
    await act(async () => {
      expect(await result.current.approveItem("stub-Draft.md")).toMatchObject({
        ok: true,
        operation: "approve",
        status: "approved",
      });
      expect(await result.current.rejectItem("stub-Draft.md")).toMatchObject({
        ok: true,
        operation: "reject",
        status: "rejected",
      });
      repeatedApproval = await result.current.approveItem("stub-Draft.md");
    });

    // Then
    expect(repeatedApproval).toMatchObject({
      ok: false,
      operation: "approve",
      code: "invalid_transition",
      status: "rejected",
    });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(result.current.items[0]?.status).toBe("rejected");
  });

  it("records decline and retries approval successfully", async () => {
    // Given
    const approve = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { result } = renderQueue(
      stubSources({ onApproveStubDraft: approve })
    );

    // When
    await act(async () => {
      expect(await result.current.approveItem("stub-Draft.md")).toMatchObject({
        ok: false,
        code: "declined",
        status: "drafted",
      });
      expect(await result.current.approveItem("stub-Draft.md")).toMatchObject({
        ok: true,
        status: "approved",
      });
    });

    // Then
    expect(approve).toHaveBeenCalledTimes(2);
    expect(result.current.items[0]?.attempts.approve).toBe(2);
    expect(result.current.items[0]?.failures.approve).toBeUndefined();
  });

  it("converts thrown approval errors into retryable failed outcomes", async () => {
    // Given
    const approve = vi.fn().mockRejectedValue(new Error("approval failed"));
    const { result } = renderQueue(
      stubSources({ onApproveStubDraft: approve })
    );

    // When
    let actionResult: ReviewActionResult | undefined;
    await act(async () => {
      actionResult = await result.current.approveItem("stub-Draft.md");
    });

    // Then
    expect(actionResult).toMatchObject({
      ok: false,
      operation: "approve",
      code: "failed",
      message: "approval failed",
      status: "drafted",
    });
    expect(result.current.items[0]?.attempts.approve).toBe(1);
    expect(result.current.items[0]?.failures.approve?.code).toBe("failed");
  });
});
