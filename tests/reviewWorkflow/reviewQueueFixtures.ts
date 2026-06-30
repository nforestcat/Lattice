import { act, renderHook } from "@testing-library/react";
import { expect } from "vitest";
import type { StubDraftReview } from "../../src/api/types";
import type { InboxCaptureBlock } from "../../src/core/capture";
import {
  useReviewQueue,
  type ReviewQueueSources,
} from "../../src/ui/hooks/useReviewQueue";

export const capture: InboxCaptureBlock = {
  id: "capture-1",
  title: "2026-06-18 09:00",
  body: "Captured text",
  markdown: "Captured text",
  relatedTitle: "Inbox.md",
};

const draft: StubDraftReview = {
  content: "# Draft",
  status: "done",
};

export function sources(
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

export function stubSources(
  overrides: Partial<ReviewQueueSources> = {}
): ReviewQueueSources {
  return sources({
    inboxCaptures: [],
    bulkDrafts: { "Draft.md": draft },
    ...overrides,
  });
}

export function deferred<T>() {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

export function renderQueue(currentSources: ReviewQueueSources = sources()) {
  return renderHook(() => useReviewQueue(currentSources));
}

export async function approveCapture(
  result: ReturnType<typeof renderQueue>["result"]
): Promise<void> {
  await act(async () => {
    expect(await result.current.approveItem("capture-1")).toMatchObject({
      ok: true,
      operation: "approve",
      status: "approved",
    });
  });
}
