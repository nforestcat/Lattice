import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewQueueItemCard } from "../src/ui/components/ReviewQueueItemCard";
import type { ReviewWorkflowItem } from "../src/ui/reviewWorkflow/ledger";
import type { ReviewItemKind, ReviewItemStatus } from "../src/api/types";

function makeItem(overrides: Partial<ReviewWorkflowItem>): ReviewWorkflowItem {
  return {
    id: "test-1",
    title: "Test Item",
    path: "test.md",
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

function renderCard(item: ReviewWorkflowItem) {
  return render(
    <ReviewQueueItemCard
      item={item}
      onApply={noop}
      onApprove={noop}
      onReject={noop}
    />,
  );
}

function buttonNames(): string[] {
  const card = screen.getByTestId("review-queue-item");
  return [...card.querySelectorAll("button")].map((b) => b.textContent ?? "");
}

describe("ReviewQueueItemCard capabilities", () => {
  it("shows Approve/Reject for drafted inbox_capture", () => {
    renderCard(makeItem({ kind: "inbox_capture", status: "drafted" }));
    const names = buttonNames();
    expect(names).toContain("Approve");
    expect(names).toContain("Reject");
    expect(names).not.toContain("Apply");
  });

  it("shows Apply/Reject for approved inbox_capture", () => {
    renderCard(makeItem({ kind: "inbox_capture", status: "approved" }));
    const names = buttonNames();
    expect(names).toContain("Apply");
    expect(names).toContain("Reject");
    expect(names).not.toContain("Approve");
  });

  it("shows only Reject for advisory-only dead_link", () => {
    renderCard(makeItem({ kind: "dead_link", status: "drafted" }));
    const names = buttonNames();
    expect(names).toContain("Reject");
    expect(names).not.toContain("Approve");
    expect(names).not.toContain("Apply");
  });

  it("shows only Reject for too_broad without suggestion", () => {
    renderCard(makeItem({ kind: "too_broad", status: "drafted", suggestionKind: "split" }));
    const names = buttonNames();
    expect(names).toContain("Reject");
    expect(names).not.toContain("Approve");
  });

  it("shows Applied label for applied item", () => {
    renderCard(makeItem({ kind: "inbox_capture", status: "applied", changedPaths: ["test.md"] }));
    const names = buttonNames();
    expect(names).toContain("Applied");
    expect(names).not.toContain("Approve");
    expect(names).not.toContain("Apply");
  });

  it("shows Committed label for committed item", () => {
    renderCard(makeItem({ kind: "inbox_capture", status: "committed" }));
    const names = buttonNames();
    expect(names).toContain("Committed");
  });

  it("shows Rejected label for rejected item", () => {
    renderCard(makeItem({ kind: "inbox_capture", status: "rejected" }));
    const names = buttonNames();
    expect(names).toContain("Rejected");
    expect(names).not.toContain("Approve");
  });

  it("disables all buttons when inFlight is set", () => {
    const promise = Promise.resolve({ ok: true as const, operation: "approve" as const, itemId: "test-1", status: "approved" as const, deduplicated: false });
    renderCard(makeItem({
      kind: "inbox_capture",
      status: "drafted",
      inFlight: { operation: "approve", promise },
    }));
    const card = screen.getByTestId("review-queue-item");
    const buttons = [...card.querySelectorAll("button")] as HTMLButtonElement[];
    const actionButtons = buttons.filter((b) => ["Approve", "Reject"].includes(b.textContent ?? ""));
    expect(actionButtons.length).toBeGreaterThan(0);
    for (const btn of actionButtons) {
      expect(btn.disabled).toBe(true);
    }
  });

  it("renders diff (이전/이후) for drafted proposed_edit with original", () => {
    renderCard(makeItem({
      kind: "proposed_edit" as ReviewItemKind,
      status: "drafted",
      original: "old content",
      proposed: "new content",
    }));
    expect(screen.getByText("이전")).toBeTruthy();
    expect(screen.getByText("이후")).toBeTruthy();
  });

  it("renders destructive pill for merge_or_delete suggestion kind", () => {
    renderCard(makeItem({
      kind: "duplicate_warning" as ReviewItemKind,
      status: "drafted",
      suggestionKind: "merge_or_delete" as any,
    }));
    expect(screen.getByTestId("risk-destructive-pill")).toBeTruthy();
    expect(screen.getByText("파괴적 변경 (merge/delete)")).toBeTruthy();
  });

  it("does not show diff for previewable suggestion until toggle clicked", () => {
    renderCard(makeItem({
      kind: "orphan_note" as ReviewItemKind,
      status: "drafted",
      suggestionKind: "link_candidates" as any,
    }));
    expect(screen.queryByText("이전")).toBeNull();
    expect(screen.queryByText("이후")).toBeNull();
  });

  it("shows failure message when a failure exists", () => {
    renderCard(makeItem({
      kind: "inbox_capture",
      status: "approved",
      failures: {
        apply: {
          ok: false,
          operation: "apply",
          itemId: "test-1",
          status: "approved",
          code: "failed",
          message: "Apply completed without changing a path.",
          warnings: [],
        },
      },
    }));
    expect(screen.getByText("Apply completed without changing a path.")).toBeTruthy();
  });
});
