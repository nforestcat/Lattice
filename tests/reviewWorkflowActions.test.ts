import { describe, expect, it } from "vitest";
import type { ReviewQueueItem } from "../src/api/types";
import type { ReviewLedgerEntry } from "../src/ui/reviewWorkflow/ledger";
import {
  synchronizeReviewLedger,
  projectReviewItem,
} from "../src/ui/reviewWorkflow/ledger";
import {
  actionFailure,
  cachedSuccess,
  inFlightResult,
  normalizeMutation,
  supportsAction,
} from "../src/ui/reviewWorkflow/actionGuards";
import { runReservedReviewAction } from "../src/ui/reviewWorkflow/actionExecution";

function makeItem(overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    id: "test-1",
    kind: "proposed_edit",
    status: "drafted",
    title: "Test",
    path: "Note.md",
    ...overrides,
  } as ReviewQueueItem;
}

function makeEntry(
  overrides: Partial<ReviewLedgerEntry> = {}
): ReviewLedgerEntry {
  return {
    item: makeItem(),
    status: "drafted",
    changedPaths: [],
    warnings: [],
    attempts: { approve: 0, reject: 0, apply: 0, commit: 0 },
    failures: {},
    successes: {},
    inFlight: null,
    commitFailure: null,
    ...overrides,
  };
}

describe("reviewWorkflow actionGuards", () => {
  it("accepts valid approve on drafted proposed_edit", () => {
    const entry = makeEntry();
    expect(supportsAction(entry, "approve")).toBe(true);
  });

  it("rejects apply on drafted item (invalid transition)", () => {
    const entry = makeEntry();
    expect(supportsAction(entry, "apply")).toBe(false);
  });

  it("returns cached success when already applied (idempotent)", () => {
    const success = {
      ok: true as const,
      operation: "apply" as const,
      itemId: "test-1",
      status: "applied" as const,
      changedPaths: ["Note.md"],
      warnings: [],
      deduplicated: false,
    };
    const entry = makeEntry({ successes: { apply: success } });
    const result = cachedSuccess(entry, "apply");
    expect(result).toMatchObject({ ok: true, deduplicated: true });
  });

  it("returns undefined for no cached success", () => {
    const entry = makeEntry();
    expect(cachedSuccess(entry, "approve")).toBeUndefined();
  });

  it("returns busy failure when different operation in flight", async () => {
    const entry = makeEntry({
      inFlight: {
        operation: "approve",
        promise: Promise.resolve({
          ok: true,
          operation: "approve",
          itemId: "test-1",
          status: "approved",
          deduplicated: false,
        }),
      },
    });
    const result = await inFlightResult(entry, "reject");
    expect(result).toMatchObject({ ok: false, code: "busy" });
  });

  it("normalizes mutation paths", () => {
    const result = normalizeMutation({
      changedPaths: ["Folder\\Note.md", "./Folder\\Note.md", "Other.md"],
      warnings: [],
    });
    expect(result.changedPaths).toEqual(["Folder/Note.md", "Other.md"]);
  });

  it("actionFailure builds correct shape", () => {
    const entry = makeEntry();
    const f = actionFailure("approve", entry, "not_found", "missing");
    expect(f).toEqual({
      ok: false,
      operation: "approve",
      itemId: "test-1",
      status: "drafted",
      code: "not_found",
      message: "missing",
      warnings: [],
    });
  });
});

describe("reviewWorkflow ledger", () => {
  it("synchronizes new items into ledger", () => {
    const ledger = new Map<string, ReviewLedgerEntry>();
    const items = [makeItem({ id: "a" }), makeItem({ id: "b" })];
    synchronizeReviewLedger(ledger, items);
    expect(ledger.size).toBe(2);
    expect(ledger.get("a")?.status).toBe("drafted");
  });

  it("removes stale entries on sync", () => {
    const ledger = new Map<string, ReviewLedgerEntry>();
    ledger.set("old", makeEntry({ item: makeItem({ id: "old" }) }));
    synchronizeReviewLedger(ledger, [makeItem({ id: "new" })]);
    expect(ledger.has("old")).toBe(false);
    expect(ledger.has("new")).toBe(true);
  });

  it("preserves existing entry state on re-sync", () => {
    const ledger = new Map<string, ReviewLedgerEntry>();
    const entry = makeEntry({ status: "approved" });
    ledger.set("test-1", entry);
    synchronizeReviewLedger(ledger, [makeItem({ id: "test-1" })]);
    expect(ledger.get("test-1")?.status).toBe("approved");
  });

  it("projects entry to workflow item", () => {
    const entry = makeEntry({ changedPaths: ["a.md"], status: "applied" });
    const projected = projectReviewItem(entry);
    expect(projected.status).toBe("applied");
    expect(projected.changedPaths).toEqual(["a.md"]);
  });
});

describe("reviewWorkflow actionExecution", () => {
  it("accepts valid action and resolves success", async () => {
    const entry = makeEntry();
    let published = 0;
    const result = await runReservedReviewAction({
      entry,
      operation: "approve",
      execute: () => ({
        ok: true,
        operation: "approve",
        itemId: "test-1",
        status: "approved",
        deduplicated: false,
      }),
      publish: () => { published++; },
    });
    expect(result).toMatchObject({ ok: true, status: "approved" });
    expect(entry.successes.approve).toBeDefined();
    expect(entry.inFlight).toBeNull();
    expect(published).toBeGreaterThanOrEqual(2);
  });

  it("rejects with failure on executor error", async () => {
    const entry = makeEntry();
    const result = await runReservedReviewAction({
      entry,
      operation: "approve",
      execute: () => { throw new Error("boom"); },
      publish: () => {},
    });
    expect(result).toMatchObject({ ok: false, code: "failed", message: "boom" });
    expect(entry.failures.approve).toBeDefined();
  });

  it("returns busy when same operation already in flight", async () => {
    const inFlightPromise = new Promise<never>(() => {});
    const entry = makeEntry({
      inFlight: { operation: "approve", promise: inFlightPromise },
    });
    const result = await runReservedReviewAction({
      entry,
      operation: "reject",
      execute: () => ({ ok: true, operation: "reject", itemId: "test-1", status: "rejected", deduplicated: false }),
      publish: () => {},
    });
    expect(result).toMatchObject({ ok: false, code: "busy" });
  });

  it("applies idempotently via in-flight dedup", async () => {
    const entry = makeEntry();
    let callCount = 0;
    const action = () => runReservedReviewAction({
      entry,
      operation: "approve",
      execute: () => {
        callCount++;
        return new Promise((resolve) =>
          setTimeout(() => resolve({
            ok: true, operation: "approve", itemId: "test-1", status: "approved", deduplicated: false,
          }), 10)
        );
      },
      publish: () => {},
    });
    const [r1, r2] = await Promise.all([action(), action()]);
    expect(r1).toMatchObject({ ok: true });
    expect(r2).toMatchObject({ ok: true });
    expect(callCount).toBe(1);
  });
});
