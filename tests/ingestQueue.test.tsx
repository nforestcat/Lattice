import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultApi } from "../src/api";
import type {
  EntryMutationResult,
  IngestDuplicateCheck,
  IngestRaw,
  IngestResult,
  SaveResult,
} from "../src/api/types";
import { useIngestQueue } from "../src/ui/hooks/useIngestQueue";

const RAW: IngestRaw = {
  title: "Source Article",
  text: "Durable source text.",
  sourceRef: "https://example.com/source",
  sourceType: "url",
};

const RESULT: IngestResult = {
  title: "Source Article",
  markdown: "# Source Article\n\nUseful detail.",
  tags: ["research"],
};

const DUPLICATE_CHECK: IngestDuplicateCheck = {
  exactMatch: null,
  similarNotes: [{ path: "Research/Existing.md", title: "Existing" }],
};

const EMPTY_MUTATION: EntryMutationResult = {
  vault: { rootPath: "Demo Vault", notes: [], tree: [] },
  selectedPath: null,
};

const CREATED_MUTATION: EntryMutationResult = {
  vault: { rootPath: "Demo Vault", notes: [], tree: [] },
  selectedPath: "Ingested/Source Article.md",
};

const SAVED: SaveResult = {
  saved: true,
  revision: "rev-next",
  conflict: false,
  snapshotId: null,
  gitCommit: null,
};

const UNSAVED_CONFLICT: SaveResult = {
  saved: false,
  revision: "rev-existing",
  conflict: true,
  snapshotId: "snapshot-conflict",
  gitCommit: null,
};

function renderQueue(onIngested = vi.fn()) {
  const setVault = vi.fn();
  const hook = renderHook(() => useIngestQueue({ onIngested, setVault }));
  let itemId = "";
  act(() => {
    itemId = hook.result.current.enqueueIngest(RESULT, RAW, DUPLICATE_CHECK);
  });
  return { ...hook, itemId, onIngested, setVault };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useIngestQueue source executor", () => {
  it("creates, saves, publishes the vault, and notifies in durable mutation order", async () => {
    // Given
    const events: string[] = [];
    vi.spyOn(vaultApi, "createNote").mockImplementation(async () => {
      events.push("create");
      return CREATED_MUTATION;
    });
    vi.spyOn(vaultApi, "saveNote").mockImplementation(async () => {
      events.push("save");
      return SAVED;
    });
    const onIngested = vi.fn(async () => {
      events.push("onIngested");
    });
    const setVault = vi.fn(() => {
      events.push("setVault");
    });
    const { result } = renderHook(() => useIngestQueue({ onIngested, setVault }));
    let itemId = "";
    act(() => {
      itemId = result.current.enqueueIngest(RESULT, RAW, DUPLICATE_CHECK);
    });

    // When
    let applied;
    await act(async () => {
      applied = await result.current.applyIngestItem(itemId);
    });

    // Then
    expect(applied).toEqual({
      changedPaths: ["Ingested/Source Article.md"],
      warnings: [],
    });
    expect(events).toEqual(["create", "save", "setVault", "onIngested"]);
  });

  it("appends with the latest revision and preserves existing content formatting", async () => {
    // Given
    vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Research/Existing.md",
      content: "# Existing\n\nOriginal content.",
      revision: "rev-existing",
    });
    const saveNote = vi.spyOn(vaultApi, "saveNote").mockResolvedValue(SAVED);
    const createNote = vi.spyOn(vaultApi, "createNote").mockResolvedValue(EMPTY_MUTATION);
    const queue = renderQueue();
    act(() => {
      queue.result.current.updateIngestItem(queue.itemId, {
        appendTargetPath: "Research/Existing.md",
      });
    });

    // When
    let applied;
    await act(async () => {
      applied = await queue.result.current.applyIngestItem(queue.itemId);
    });

    // Then
    expect(applied).toEqual({ changedPaths: ["Research/Existing.md"], warnings: [] });
    expect(saveNote).toHaveBeenCalledWith(
      "Research/Existing.md",
      expect.stringContaining("Original content.\n\n### Ingested Source (Source Article)"),
      "rev-existing",
    );
    expect(createNote).not.toHaveBeenCalled();
  });

  it("fails append without post-write notification when save resolves unsaved", async () => {
    // Given
    vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Research/Existing.md",
      content: "# Existing\n\nOriginal content.",
      revision: "rev-existing",
    });
    vi.spyOn(vaultApi, "saveNote").mockResolvedValue(UNSAVED_CONFLICT);
    const queue = renderQueue();
    act(() => {
      queue.result.current.updateIngestItem(queue.itemId, {
        appendTargetPath: "Research/Existing.md",
      });
    });

    // When / Then
    await act(async () => {
      await expect(queue.result.current.applyIngestItem(queue.itemId)).rejects.toMatchObject({
        code: "save_not_durable",
        path: "Research/Existing.md",
      });
    });
    expect(queue.onIngested).not.toHaveBeenCalled();
    expect(queue.setVault).not.toHaveBeenCalled();
  });

  it("rolls back only a newly created note when its initial save fails", async () => {
    // Given
    const saveError = new Error("save failed");
    vi.spyOn(vaultApi, "createNote").mockResolvedValue(CREATED_MUTATION);
    vi.spyOn(vaultApi, "saveNote").mockRejectedValue(saveError);
    const deleteEntry = vi.spyOn(vaultApi, "deleteEntry").mockResolvedValue(EMPTY_MUTATION);
    const queue = renderQueue();

    // When / Then
    await act(async () => {
      await expect(queue.result.current.applyIngestItem(queue.itemId)).rejects.toBe(saveError);
    });
    expect(deleteEntry).toHaveBeenCalledWith("Ingested/Source Article.md");
    expect(queue.onIngested).not.toHaveBeenCalled();
    expect(queue.setVault).not.toHaveBeenCalled();
  });

  it("rolls back a newly created note when initial save resolves unsaved", async () => {
    // Given
    vi.spyOn(vaultApi, "createNote").mockResolvedValue(CREATED_MUTATION);
    vi.spyOn(vaultApi, "saveNote").mockResolvedValue(UNSAVED_CONFLICT);
    const deleteEntry = vi.spyOn(vaultApi, "deleteEntry").mockResolvedValue(EMPTY_MUTATION);
    const queue = renderQueue();

    // When / Then
    await act(async () => {
      await expect(queue.result.current.applyIngestItem(queue.itemId)).rejects.toMatchObject({
        code: "save_not_durable",
        path: "Ingested/Source Article.md",
      });
    });
    expect(deleteEntry).toHaveBeenCalledTimes(1);
    expect(deleteEntry).toHaveBeenCalledWith("Ingested/Source Article.md");
    expect(queue.onIngested).not.toHaveBeenCalled();
    expect(queue.setVault).not.toHaveBeenCalled();
  });

  it("returns the durable path and a warning when notification fails after save", async () => {
    // Given
    vi.spyOn(vaultApi, "createNote").mockResolvedValue(CREATED_MUTATION);
    vi.spyOn(vaultApi, "saveNote").mockResolvedValue(SAVED);
    const deleteEntry = vi.spyOn(vaultApi, "deleteEntry").mockResolvedValue(EMPTY_MUTATION);
    const queue = renderQueue(vi.fn().mockRejectedValue(new Error("refresh failed")));

    // When
    let applied;
    await act(async () => {
      applied = await queue.result.current.applyIngestItem(queue.itemId);
    });

    // Then
    expect(applied).toEqual({
      changedPaths: ["Ingested/Source Article.md"],
      warnings: [{
        code: "post_action_failed",
        message: "refresh failed",
        path: "Ingested/Source Article.md",
      }],
    });
    expect(deleteEntry).not.toHaveBeenCalled();
  });

  it("allows a second executor invocation because lifecycle deduplication is external", async () => {
    // Given
    const createNote = vi.spyOn(vaultApi, "createNote").mockResolvedValue(CREATED_MUTATION);
    const saveNote = vi.spyOn(vaultApi, "saveNote").mockResolvedValue(SAVED);
    const queue = renderQueue();

    // When
    await act(async () => {
      await queue.result.current.applyIngestItem(queue.itemId);
      await queue.result.current.applyIngestItem(queue.itemId);
    });

    // Then
    expect(createNote).toHaveBeenCalledTimes(2);
    expect(saveNote).toHaveBeenCalledTimes(2);
  });
});
