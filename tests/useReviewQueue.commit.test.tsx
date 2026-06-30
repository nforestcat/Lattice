import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InboxCaptureBlock } from "../src/core/capture";
import type { ReviewActionFailure } from "../src/ui/reviewWorkflow/contracts";
import {
  approveCapture,
  capture,
  renderQueue,
  sources,
} from "./reviewWorkflow/reviewQueueFixtures";

describe("useReviewQueue commit attribution", () => {
  it("commits only items whose full normalized path set is covered", async () => {
    // Given
    const secondCapture: InboxCaptureBlock = {
      ...capture,
      id: "capture-2",
      title: "2026-06-19 09:00",
    };
    const { result } = renderQueue(
      sources({ inboxCaptures: [capture, secondCapture] })
    );
    await act(async () => {
      await result.current.approveItem("capture-1");
      await result.current.approveItem("capture-2");
      await result.current.applyItem("capture-1", () => ({
        changedPaths: ["Inbox.md", "Daily\\One.md"],
        warnings: [],
      }));
      await result.current.applyItem("capture-2", () => ({
        changedPaths: ["Other.md"],
        warnings: [],
      }));
    });

    // When
    let partial: ReturnType<typeof result.current.markCommittedPaths> | undefined;
    let complete: ReturnType<typeof result.current.markCommittedPaths> | undefined;
    act(() => {
      partial = result.current.markCommittedPaths(["./Inbox.md"]);
      complete = result.current.markCommittedPaths([
        "Inbox.md",
        "Daily/One.md",
        "Unrelated.md",
      ]);
    });

    // Then
    expect(partial?.committedIds).toEqual([]);
    expect(partial?.result).toMatchObject({ ok: false, code: "not_found" });
    expect(complete?.committedIds).toEqual(["capture-1"]);
    expect(complete?.result).toMatchObject({
      ok: true,
      operation: "commit",
      committedIds: ["capture-1"],
    });
    expect(result.current.items.find((item) => item.id === "capture-1")?.status)
      .toBe("committed");
    expect(result.current.items.find((item) => item.id === "capture-2")?.status)
      .toBe("applied");
  });

  it("rejects apply after committed paths cover an applied item without reusing cached apply", async () => {
    // Given
    const apply = vi.fn(() => ({
      changedPaths: ["Inbox.md", "Daily/One.md"],
      warnings: [],
    }));
    const { result } = renderQueue();
    await approveCapture(result);
    await act(async () => {
      expect(await result.current.applyItem("capture-1", apply)).toMatchObject({
        ok: true,
        operation: "apply",
        status: "applied",
      });
    });
    act(() => {
      result.current.markCommittedPaths(["Inbox.md", "Daily/One.md"]);
    });

    // When
    let repeatedApply: Awaited<ReturnType<typeof result.current.applyItem>> | undefined;
    await act(async () => {
      repeatedApply = await result.current.applyItem("capture-1", apply);
    });

    // Then
    expect(repeatedApply).toMatchObject({
      ok: false,
      operation: "apply",
      code: "invalid_transition",
      status: "committed",
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(result.current.items[0]?.status).toBe("committed");
  });

  it("records commit failure only for fully covered applied items and clears it", async () => {
    // Given
    const { result } = renderQueue();
    await approveCapture(result);
    await act(async () => {
      await result.current.applyItem("capture-1", () => ({
        changedPaths: ["Inbox.md", "Daily\\One.md"],
        warnings: [],
      }));
    });
    const failure: ReviewActionFailure = {
      ok: false,
      operation: "commit",
      itemId: null,
      status: "applied",
      code: "failed",
      message: "git commit failed",
      warnings: [],
    };

    // When
    let partialIds: readonly string[] = [];
    let affectedIds: readonly string[] = [];
    act(() => {
      partialIds = result.current.recordCommitFailure(["Inbox.md"], failure);
      affectedIds = result.current.recordCommitFailure(
        ["./Inbox.md", "Daily/One.md"],
        failure
      );
    });

    // Then
    expect(partialIds).toEqual([]);
    expect(affectedIds).toEqual(["capture-1"]);
    expect(result.current.items[0]?.commitFailure).toEqual({
      attemptedPaths: ["Daily/One.md", "Inbox.md"],
      failure,
    });
    act(() => {
      result.current.markCommittedPaths(["Inbox.md", "Daily/One.md"]);
    });
    expect(result.current.items[0]?.commitFailure).toBeNull();
    expect(result.current.items[0]?.failures.commit).toBeUndefined();
  });
});
