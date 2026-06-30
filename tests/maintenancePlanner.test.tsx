import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultApi } from "../src/api";
import { sendChatMessage } from "../src/api/llm";
import type {
  ContextBundleCandidate,
  LlmConfig,
  ReviewQueueItem,
  SaveResult,
} from "../src/api/types";
import { useMaintenancePlanner } from "../src/ui/hooks/useMaintenancePlanner";

vi.mock("../src/api/llm", () => ({ sendChatMessage: vi.fn() }));

const LLM_CONFIG: LlmConfig = { provider: "custom", apiKey: "test-key", model: "test-model", baseUrl: "http://localhost:1234/v1" };
const SAVED: SaveResult = { saved: true, revision: "rev-2", conflict: false, snapshotId: null, gitCommit: null };
const UNSAVED_CONFLICT: SaveResult = { saved: false, revision: "rev-1", conflict: true, snapshotId: "snapshot-conflict", gitCommit: null };

function item(
  suggestionKind: ReviewQueueItem["suggestionKind"],
  kind: ReviewQueueItem["kind"] = "weak_backlinks",
): ReviewQueueItem {
  return {
    id: `health-Notes/Target.md-${suggestionKind}`,
    sourceId: "Notes/Target.md",
    kind,
    status: "drafted",
    path: "Notes/Target.md",
    title: "Target",
    gitStaged: false,
    createdAt: 0,
    suggestionKind,
  };
}

function candidate(path: string): ContextBundleCandidate {
  return { path, title: path, reason: "Recommended", reasonDetail: "", score: 1, excerpt: "", tokenEstimate: 0, selected: false, characterCount: 0 };
}

function hydrate(
  result: ReturnType<typeof useMaintenancePlanner>,
  reviewItem: ReviewQueueItem,
): void {
  act(() => {
    result.hydrate({
      [reviewItem.id]: {
        proposed: "Generated suggestion",
        provenance: { source: "maintenance_planner", model: "test-model" },
        generatedAt: "2026-06-23T00:00:00.000Z",
      },
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(sendChatMessage).mockReset();
});

describe("useMaintenancePlanner", () => {
  it("generates a suggestion from current note content", async () => {
    // Given
    const reviewItem = item("summary", "missing_summary");
    vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: reviewItem.path,
      content: "# Target\nActual current body.",
      revision: "rev-1",
    });
    vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({});
    vi.spyOn(vaultApi, "saveVaultConfig").mockResolvedValue(undefined);
    vi.mocked(sendChatMessage).mockResolvedValue("A generated summary.");
    const { result } = renderHook(() => useMaintenancePlanner());

    // When
    await act(async () => {
      await result.current.generate(reviewItem, LLM_CONFIG);
    });

    // Then
    expect(sendChatMessage).toHaveBeenCalledWith(
      LLM_CONFIG,
      [{ role: "user", content: expect.stringContaining("Actual current body.") }],
    );
    await waitFor(() => {
      expect(result.current.suggestions[reviewItem.id]).toBe("A generated summary.");
    });
  });

  it("returns a structured full-success result after applying summary metadata", async () => {
    // Given
    const reviewItem = item("summary", "missing_summary");
    vi.spyOn(vaultApi, "applyNoteMetadata").mockResolvedValue(undefined);
    vi.spyOn(vaultApi, "appendAiAudit").mockResolvedValue(undefined);
    const { result } = renderHook(() => useMaintenancePlanner());
    hydrate(result.current, reviewItem);

    // When
    let applied;
    await act(async () => {
      applied = await result.current.apply(reviewItem);
    });

    // Then
    expect(applied).toEqual({ changedPaths: ["Notes/Target.md"], warnings: [] });
    expect(vaultApi.applyNoteMetadata).toHaveBeenCalledWith(
      "Notes/Target.md",
      { summary: "Generated suggestion" },
      [],
    );
  });

  it("fails when no candidate mutation succeeds", async () => {
    // Given
    const reviewItem = item("backlinks_in");
    vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      candidate("Notes/A.md"),
      candidate("Notes/B.md"),
    ]);
    vi.spyOn(vaultApi, "readNote").mockImplementation(async (path) => ({
      path,
      content: "# Candidate",
      revision: "rev-1",
    }));
    vi.spyOn(vaultApi, "saveNote").mockRejectedValue(new Error("save failed"));
    const { result } = renderHook(() => useMaintenancePlanner());
    hydrate(result.current, reviewItem);

    // When / Then
    await act(async () => {
      await expect(result.current.apply(reviewItem)).rejects.toMatchObject({
        code: "zero_changes",
        warnings: [
          { code: "partial_failure", path: "Notes/A.md" },
          { code: "partial_failure", path: "Notes/B.md" },
        ],
      });
    });
  });

  it("fails with zero changes when every candidate save resolves unsaved", async () => {
    // Given
    const reviewItem = item("backlinks_in");
    vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      candidate("Notes/A.md"),
      candidate("Notes/B.md"),
    ]);
    vi.spyOn(vaultApi, "readNote").mockImplementation(async (path) => ({
      path,
      content: "# Candidate",
      revision: "rev-1",
    }));
    vi.spyOn(vaultApi, "saveNote").mockResolvedValue(UNSAVED_CONFLICT);
    const { result } = renderHook(() => useMaintenancePlanner());
    hydrate(result.current, reviewItem);

    // When / Then
    await act(async () => {
      await expect(result.current.apply(reviewItem)).rejects.toMatchObject({
        code: "zero_changes",
        warnings: [
          {
            code: "partial_failure",
            message: expect.stringContaining("conflict=true"),
            path: "Notes/A.md",
          },
          {
            code: "partial_failure",
            message: expect.stringContaining("conflict=true"),
            path: "Notes/B.md",
          },
        ],
      });
    });
  });

  it("returns successful paths and failed-target warnings after partial success", async () => {
    // Given
    const reviewItem = item("link_candidates", "orphan_note");
    vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      candidate("Notes/A.md"),
      candidate("Notes/B.md"),
      candidate("Notes/C.md"),
    ]);
    vi.spyOn(vaultApi, "readNote").mockImplementation(async (path) => ({
      path,
      content: "# Candidate",
      revision: "rev-1",
    }));
    vi.spyOn(vaultApi, "saveNote").mockImplementation(async (path) => {
      if (path === "Notes/B.md") throw new Error("B save failed");
      return SAVED;
    });
    vi.spyOn(vaultApi, "appendAiAudit").mockResolvedValue(undefined);
    const { result } = renderHook(() => useMaintenancePlanner());
    hydrate(result.current, reviewItem);

    // When
    let applied;
    await act(async () => {
      applied = await result.current.apply(reviewItem);
    });

    // Then
    expect(applied).toEqual({
      changedPaths: ["Notes/A.md", "Notes/C.md"],
      warnings: [{
        code: "partial_failure",
        message: "B save failed",
        path: "Notes/B.md",
      }],
    });
  });

  it("excludes unsaved candidate results from changed paths and returns warnings", async () => {
    // Given
    const reviewItem = item("link_candidates", "orphan_note");
    vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      candidate("Notes/A.md"),
      candidate("Notes/B.md"),
      candidate("Notes/C.md"),
    ]);
    vi.spyOn(vaultApi, "readNote").mockImplementation(async (path) => ({
      path,
      content: "# Candidate",
      revision: "rev-1",
    }));
    vi.spyOn(vaultApi, "saveNote").mockImplementation(async (path) => {
      if (path === "Notes/B.md") return UNSAVED_CONFLICT;
      return SAVED;
    });
    vi.spyOn(vaultApi, "appendAiAudit").mockResolvedValue(undefined);
    const { result } = renderHook(() => useMaintenancePlanner());
    hydrate(result.current, reviewItem);

    // When
    let applied;
    await act(async () => {
      applied = await result.current.apply(reviewItem);
    });

    // Then
    expect(applied).toEqual({
      changedPaths: ["Notes/A.md", "Notes/C.md"],
      warnings: [{
        code: "partial_failure",
        message: expect.stringContaining("snapshot-conflict"),
        path: "Notes/B.md",
      }],
    });
  });

  it("keeps a durable path when its audit append fails", async () => {
    // Given
    const reviewItem = item("review_prompt", "stale_note");
    vi.spyOn(vaultApi, "applyNoteMetadata").mockResolvedValue(undefined);
    vi.spyOn(vaultApi, "appendAiAudit").mockRejectedValue(new Error("audit unavailable"));
    const { result } = renderHook(() => useMaintenancePlanner());
    hydrate(result.current, reviewItem);

    // When
    let applied;
    await act(async () => {
      applied = await result.current.apply(reviewItem);
    });

    // Then
    expect(applied).toEqual({
      changedPaths: ["Notes/Target.md"],
      warnings: [{
        code: "post_action_failed",
        message: "audit unavailable",
        path: "Notes/Target.md",
      }],
    });
  });

  it("rejects split before metadata mutation for a missing-summary item", async () => {
    // Given
    const reviewItem = item("split", "missing_summary");
    const applyMetadata = vi.spyOn(vaultApi, "applyNoteMetadata");
    const { result } = renderHook(() => useMaintenancePlanner());
    hydrate(result.current, reviewItem);

    // When / Then
    await act(async () => {
      await expect(result.current.apply(reviewItem)).rejects.toMatchObject({
        code: "unsupported",
      });
    });
    expect(applyMetadata).not.toHaveBeenCalled();
  });
});
