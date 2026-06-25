import { act, createRef } from "react";
import type { ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultApi } from "../src/api";
import { sendChatMessage } from "../src/api/llm";
import type {
  BacklinkSuggestion,
  SaveResult,
  UnresolvedLinkSource,
  VaultSnapshot,
} from "../src/api/types";
import { useLinkSuggestions } from "../src/ui/hooks/useLinkSuggestions";
import { useStubDrafting } from "../src/ui/hooks/useStubDrafting";

vi.mock("../src/api/llm", () => ({ sendChatMessage: vi.fn() }));

const VAULT: VaultSnapshot = {
  rootPath: "Demo Vault",
  notes: [],
  tree: [],
};

const SAVED: SaveResult = {
  saved: true,
  revision: "rev-2",
  conflict: false,
  snapshotId: null,
  gitCommit: null,
};

const UNSAVED_CONFLICT: SaveResult = {
  saved: false,
  revision: "rev-1",
  conflict: true,
  snapshotId: "snapshot-conflict",
  gitCommit: null,
};

const SOURCES: readonly UnresolvedLinkSource[] = [{
  path: "Notes/Source.md",
  title: "Source",
  excerpt: "Context for the missing concept.",
}];

function renderDrafting(refreshVault = vi.fn().mockResolvedValue(undefined)) {
  const setUnresolvedLinks = vi.fn();
  const hook = renderHook(() => useStubDrafting({
    llmConfig: {
      provider: "custom",
      apiKey: "test-key",
      model: "test-model",
      baseUrl: "http://localhost:1234/v1",
    },
    vault: VAULT,
    activePath: "Notes/Source.md",
    setStatus: vi.fn(),
    refreshVault,
    unresolvedLinks: [{ target: "Concept", sources: [...SOURCES] }],
    setUnresolvedLinks,
    setIsScanningUnresolved: vi.fn(),
    activeUnresolvedTarget: "concept",
    setActiveUnresolvedTarget: vi.fn(),
  }));
  return { ...hook, refreshVault, setUnresolvedLinks };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(sendChatMessage).mockReset();
});

describe("useStubDrafting", () => {
  it("generates draft content and selection without creating a note", async () => {
    // Given
    vi.mocked(sendChatMessage).mockResolvedValue("Generated concept body.");
    const createNote = vi.spyOn(vaultApi, "createNote");
    const { result } = renderDrafting();

    // When
    await act(async () => {
      await result.current.draftStubNote("Concept", [...SOURCES]);
    });

    // Then
    expect(result.current.bulkDrafts.Concept).toEqual({
      content: "Generated concept body.",
      status: "done",
    });
    expect(result.current.selectedUnresolvedTargets.has("Concept")).toBe(true);
    expect(createNote).not.toHaveBeenCalled();
  });

  it("applies one done draft independently of selection and cleans up only success", async () => {
    // Given
    vi.mocked(sendChatMessage)
      .mockResolvedValueOnce("Concept body.")
      .mockResolvedValueOnce("Other body.");
    vi.spyOn(vaultApi, "createNote").mockImplementation(async (_parent, title) => ({
      vault: VAULT,
      selectedPath: `Ingested/${title}.md`,
    }));
    vi.spyOn(vaultApi, "readNote").mockImplementation(async (path) => ({
      path,
      content: "",
      revision: "",
    }));
    vi.spyOn(vaultApi, "saveNote").mockResolvedValue(SAVED);
    vi.spyOn(vaultApi, "getUnresolvedLinks").mockResolvedValue([]);
    const { result } = renderDrafting();
    await act(async () => {
      await result.current.draftStubNote("Concept", [...SOURCES]);
      await result.current.draftStubNote("Other", [...SOURCES]);
    });
    act(() => {
      result.current.setSelectedUnresolvedTargets(new Set());
    });

    // When
    let applied;
    await act(async () => {
      applied = await result.current.applyStubDraft("Concept");
    });

    // Then
    expect(applied).toEqual({
      changedPaths: ["Ingested/Concept.md"],
      warnings: [],
    });
    expect(result.current.bulkDrafts.Concept).toBeUndefined();
    expect(result.current.bulkDrafts.Other).toEqual({
      content: "Other body.",
      status: "done",
    });
  });

  it("rolls back a failed initial save and retains the generated draft", async () => {
    // Given
    vi.mocked(sendChatMessage).mockResolvedValue("Concept body.");
    vi.spyOn(vaultApi, "createNote").mockResolvedValue({
      vault: VAULT,
      selectedPath: "Ingested/Concept.md",
    });
    vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Ingested/Concept.md",
      content: "",
      revision: "",
    });
    const saveError = new Error("save failed");
    vi.spyOn(vaultApi, "saveNote").mockRejectedValue(saveError);
    const deleteEntry = vi.spyOn(vaultApi, "deleteEntry").mockResolvedValue({
      vault: VAULT,
      selectedPath: null,
    });
    const { result } = renderDrafting();
    await act(async () => {
      await result.current.draftStubNote("Concept", [...SOURCES]);
    });

    // When / Then
    await act(async () => {
      await expect(result.current.applyStubDraft("Concept")).rejects.toBe(saveError);
    });
    expect(deleteEntry).toHaveBeenCalledWith("Ingested/Concept.md");
    expect(result.current.bulkDrafts.Concept?.status).toBe("done");
  });

  it("rolls back an unsaved initial save result and retains the generated draft", async () => {
    // Given
    vi.mocked(sendChatMessage).mockResolvedValue("Concept body.");
    vi.spyOn(vaultApi, "createNote").mockResolvedValue({
      vault: VAULT,
      selectedPath: "Ingested/Concept.md",
    });
    vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Ingested/Concept.md",
      content: "",
      revision: "",
    });
    vi.spyOn(vaultApi, "saveNote").mockResolvedValue(UNSAVED_CONFLICT);
    const deleteEntry = vi.spyOn(vaultApi, "deleteEntry").mockResolvedValue({
      vault: VAULT,
      selectedPath: null,
    });
    const { result } = renderDrafting();
    await act(async () => {
      await result.current.draftStubNote("Concept", [...SOURCES]);
    });

    // When / Then
    await act(async () => {
      await expect(result.current.applyStubDraft("Concept")).rejects.toMatchObject({
        code: "save_not_durable",
        path: "Ingested/Concept.md",
      });
    });
    expect(deleteEntry).toHaveBeenCalledTimes(1);
    expect(deleteEntry).toHaveBeenCalledWith("Ingested/Concept.md");
    expect(result.current.bulkDrafts.Concept).toEqual({
      content: "Concept body.",
      status: "done",
    });
  });

  it("returns the durable stub path with refresh warnings", async () => {
    // Given
    vi.mocked(sendChatMessage).mockResolvedValue("Concept body.");
    vi.spyOn(vaultApi, "createNote").mockResolvedValue({
      vault: VAULT,
      selectedPath: "Ingested/Concept.md",
    });
    vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Ingested/Concept.md",
      content: "",
      revision: "",
    });
    vi.spyOn(vaultApi, "saveNote").mockResolvedValue(SAVED);
    vi.spyOn(vaultApi, "getUnresolvedLinks").mockResolvedValue([]);
    const { result } = renderDrafting(
      vi.fn().mockRejectedValue(new Error("vault refresh failed")),
    );
    await act(async () => {
      await result.current.draftStubNote("Concept", [...SOURCES]);
    });

    // When
    let applied;
    await act(async () => {
      applied = await result.current.applyStubDraft("Concept");
    });

    // Then
    expect(applied).toEqual({
      changedPaths: ["Ingested/Concept.md"],
      warnings: [{
        code: "post_action_failed",
        message: "vault refresh failed",
        path: "Ingested/Concept.md",
      }],
    });
    expect(result.current.bulkDrafts.Concept).toBeUndefined();
  });
});

describe("useLinkSuggestions source executor", () => {
  it("returns the changed source path when a post-write audit fails", async () => {
    // Given
    const suggestion: BacklinkSuggestion = {
      id: "backlink-1",
      sourcePath: "Notes/Source.md",
      sourceTitle: "Source",
      targetPath: "Notes/Target.md",
      targetTitle: "Target",
      suggestionType: "unlinked_mention",
      excerpt: "Target",
      score: 1,
    };
    vi.spyOn(vaultApi, "applyBacklinkSuggestion").mockResolvedValue(undefined);
    vi.spyOn(vaultApi, "openVault").mockResolvedValue(VAULT);
    vi.spyOn(vaultApi, "getBacklinkSuggestions").mockResolvedValue([]);
    const runHealthAudit = vi.fn().mockRejectedValue(new Error("audit failed"));
    const { result } = renderHook(() => useLinkSuggestions({
      activePath: "Notes/Target.md",
      draft: "",
      setDraft: vi.fn(),
      vault: VAULT,
      setVault: vi.fn(),
      setStatus: vi.fn(),
      editorRef: createRef<ReactCodeMirrorRef>(),
    }));

    // When
    const applied = await result.current.applyBacklinkSuggestion(
      suggestion,
      vi.fn().mockResolvedValue(undefined),
      runHealthAudit,
    );

    // Then
    expect(applied).toEqual({
      changedPaths: ["Notes/Source.md"],
      warnings: [{
        code: "post_action_failed",
        message: "audit failed",
        path: "Notes/Source.md",
      }],
    });
  });
});
