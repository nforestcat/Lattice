import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultApi } from "../src/api";
import { sendChatMessage } from "../src/api/llm";
import type { LlmConfig, ReviewQueueItem } from "../src/api/types";
import { useMaintenancePlanner } from "../src/ui/hooks/useMaintenancePlanner";

vi.mock("../src/api/llm", () => ({
  sendChatMessage: vi.fn(),
}));

const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  baseUrl: "http://localhost:1234/v1",
};

function missingSummaryItem(): ReviewQueueItem {
  return {
    id: "health-Notes/Long.md-missingSummary",
    sourceId: "Notes/Long.md",
    kind: "missing_summary",
    status: "new",
    path: "Notes/Long.md",
    title: "Long Note: missingSummary",
    gitStaged: false,
    createdAt: 0,
    sourceRef: {
      path: "Notes/Long.md",
      title: "Long Note",
      score: 70,
      issues: ["missingSummary"],
      isOrphan: false,
      isStale: false,
      isTooBroad: false,
      isDuplicated: false,
      missingSummary: true,
      weakBacklinks: false,
    },
    suggestionKind: "summary",
  };
}

describe("useMaintenancePlanner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(sendChatMessage).mockReset();
  });

  it("builds maintenance prompts from the note content instead of the health report shell", async () => {
    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Notes/Long.md",
      content: "# Long Note\nActual body that the planner must summarize.",
      revision: "rev-current",
    });
    vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({});
    const saveVaultConfigSpy = vi.spyOn(vaultApi, "saveVaultConfig").mockResolvedValue(undefined);
    vi.mocked(sendChatMessage).mockResolvedValue("A useful generated summary.");
    const { result } = renderHook(() => useMaintenancePlanner());

    await act(async () => {
      await result.current.generate(missingSummaryItem(), llmConfig);
    });

    expect(readNoteSpy).toHaveBeenCalledWith("Notes/Long.md");
    expect(sendChatMessage).toHaveBeenCalledWith(
      llmConfig,
      [
        {
          role: "user",
          content: expect.stringContaining("Actual body that the planner must summarize."),
        },
      ],
    );
    expect(saveVaultConfigSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        maintenanceSuggestions: expect.objectContaining({
          "health-Notes/Long.md-missingSummary": expect.objectContaining({
            proposed: "A useful generated summary.",
          }),
          "Notes/Long.md::summary": expect.objectContaining({
            proposed: "A useful generated summary.",
          }),
        }),
      }),
    );
    await waitFor(() => expect(result.current.suggestions["health-Notes/Long.md-missingSummary"]).toBe("A useful generated summary."));
  });

  it("applies link_candidates suggestions by inserting a backlink into the note body", async () => {
    vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Notes/Orphan.md",
      content: "# Orphan Note\nSome body.",
      revision: "rev-1",
    });
    const saveNoteSpy = vi.spyOn(vaultApi, "saveNote").mockResolvedValue({
      saved: true,
      revision: "rev-2",
      conflict: false,
      snapshotId: null,
      gitCommit: null,
    });
    const auditSpy = vi.spyOn(vaultApi, "appendAiAudit").mockResolvedValue(undefined);

    const item: ReviewQueueItem = {
      id: "health-Notes/Orphan.md-linkCandidates",
      sourceId: "Notes/Orphan.md",
      kind: "orphan_note",
      status: "new",
      path: "Notes/Orphan.md",
      title: "Orphan Note",
      gitStaged: false,
      createdAt: 0,
      suggestionKind: "link_candidates",
    };

    const { result } = renderHook(() => useMaintenancePlanner());
    act(() => {
      result.current.hydrate({
        [item.id]: {
          proposed: "Link to Other Note",
          provenance: { source: "maintenance_planner" },
          generatedAt: "2024-01-01T00:00:00.000Z",
        },
      });
    });

    let paths: string[] = [];
    await act(async () => {
      paths = await result.current.apply(item);
    });

    expect(paths).toEqual(["Notes/Orphan.md"]);
    expect(saveNoteSpy).toHaveBeenCalledWith(
      "Notes/Orphan.md",
      expect.stringContaining("[[Orphan Note]]"),
      "rev-1"
    );
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(item.status).toBe("applied");
  });

  it("applies backlinks_in suggestions sequentially across candidate notes", async () => {
    vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      {
        path: "Notes/A.md",
        title: "A",
        reason: "Recommended",
        reasonDetail: "",
        score: 1,
        excerpt: "",
        tokenEstimate: 0,
        selected: false,
        characterCount: 0,
      },
      {
        path: "Notes/B.md",
        title: "B",
        reason: "Recommended",
        reasonDetail: "",
        score: 1,
        excerpt: "",
        tokenEstimate: 0,
        selected: false,
        characterCount: 0,
      },
    ]);
    vi.spyOn(vaultApi, "readNote").mockImplementation(async (path: string) => ({
      path,
      content: `# ${path}\nBody`,
      revision: "rev-1",
    }));
    const saveNoteSpy = vi.spyOn(vaultApi, "saveNote").mockResolvedValue({
      saved: true,
      revision: "rev-2",
      conflict: false,
      snapshotId: null,
      gitCommit: null,
    });
    const auditSpy = vi.spyOn(vaultApi, "appendAiAudit").mockResolvedValue(undefined);

    const item: ReviewQueueItem = {
      id: "health-Notes/Target.md-backlinksIn",
      sourceId: "Notes/Target.md",
      kind: "weak_backlinks",
      status: "new",
      path: "Notes/Target.md",
      title: "Target",
      gitStaged: false,
      createdAt: 0,
      suggestionKind: "backlinks_in",
    };

    const { result } = renderHook(() => useMaintenancePlanner());
    act(() => {
      result.current.hydrate({
        [item.id]: {
          proposed: "Add links from A and B",
          provenance: { source: "maintenance_planner" },
          generatedAt: "2024-01-01T00:00:00.000Z",
        },
      });
    });

    let paths: string[] = [];
    await act(async () => {
      paths = await result.current.apply(item);
    });

    expect(paths).toEqual(["Notes/A.md", "Notes/B.md"]);
    expect(saveNoteSpy).toHaveBeenCalledTimes(2);
    expect(auditSpy).toHaveBeenCalledTimes(2);
    expect(item.status).toBe("applied");
  });

  it("applies review_prompt suggestions by writing reviewRequestedAt metadata", async () => {
    const applyMetaSpy = vi.spyOn(vaultApi, "applyNoteMetadata").mockResolvedValue(undefined);
    const auditSpy = vi.spyOn(vaultApi, "appendAiAudit").mockResolvedValue(undefined);

    const item: ReviewQueueItem = {
      id: "health-Notes/Stale.md-reviewPrompt",
      sourceId: "Notes/Stale.md",
      kind: "stale_note",
      status: "new",
      path: "Notes/Stale.md",
      title: "Stale Note",
      gitStaged: false,
      createdAt: 0,
      suggestionKind: "review_prompt",
    };

    const { result } = renderHook(() => useMaintenancePlanner());
    act(() => {
      result.current.hydrate({
        [item.id]: {
          proposed: "Review section X",
          provenance: { source: "maintenance_planner" },
          generatedAt: "2024-01-01T00:00:00.000Z",
        },
      });
    });

    let paths: string[] = [];
    await act(async () => {
      paths = await result.current.apply(item);
    });

    expect(paths).toEqual(["Notes/Stale.md"]);
    expect(applyMetaSpy).toHaveBeenCalledWith(
      "Notes/Stale.md",
      expect.objectContaining({ reviewRequestedAt: expect.any(String) }),
      []
    );
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(item.status).toBe("applied");
  });
});
