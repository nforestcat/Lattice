import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewQueuePanel } from "../src/ui/components/ReviewQueuePanel";
import type { ReviewWorkflowItem } from "../src/ui/reviewWorkflow/ledger";

function makeItem(overrides: Partial<ReviewWorkflowItem>): ReviewWorkflowItem {
  return {
    id: "item-1",
    title: "Item One",
    path: "one.md",
    kind: "inbox_capture",
    status: "drafted",
    createdAt: Date.now(),
    gitStaged: false,
    changedPaths: [],
    warnings: [],
    attempts: { approve: 0, reject: 0, apply: 0, commit: 0 },
    failures: {},
    inFlight: null,
    commitFailure: null,
    ...overrides,
  } as ReviewWorkflowItem;
}

const noop = vi.fn();

function renderPanel(items: ReviewWorkflowItem[], extra: Partial<Parameters<typeof ReviewQueuePanel>[0]> = {}) {
  return render(
    <ReviewQueuePanel items={items} onApply={noop} onApprove={noop} onReject={noop} {...extra} />,
  );
}

describe("ReviewQueuePanel", () => {
  it("shows the empty state when there are no items", () => {
    renderPanel([]);
    expect(screen.getByText("검토할 항목이 없습니다")).toBeTruthy();
  });

  it("filters items by status via the filter tabs", () => {
    renderPanel([
      makeItem({ id: "a", title: "Drafted Item", status: "drafted" }),
      makeItem({ id: "b", title: "Approved Item", status: "approved" }),
    ]);

    expect(screen.getAllByTestId("review-queue-item")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "approved" }));
    expect(screen.getAllByTestId("review-queue-item")).toHaveLength(1);
    expect(screen.getByText("Approved Item")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "rejected" }));
    expect(screen.queryAllByTestId("review-queue-item")).toHaveLength(0);
    expect(screen.getByText("검토할 항목이 없습니다")).toBeTruthy();
  });

  it("shows a disabled Staged button for items staged by the queue", () => {
    renderPanel(
      [makeItem({ id: "a", title: "Staged Item", status: "applied" })],
      { onStage: noop, canStageItem: () => true, stagedByQueue: new Set(["a"]) },
    );

    const staged = screen.getByRole("button", { name: "Staged" });
    expect(staged.hasAttribute("disabled")).toBe(true);
  });
});
