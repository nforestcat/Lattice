import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultApi } from "../src/api";
import type { GitStatus, NoteDocument, UnresolvedLinkGroup, UnresolvedLinkSource } from "../src/api/types";
import { useGit, type UseGitCallbacks } from "../src/ui/hooks/useGit";

function gitStatus(): GitStatus {
  return {
    isRepo: true,
    autoGitEnabled: false,
    branch: "main",
    hasChanges: false,
    hasConflicts: false,
  };
}

function callbacks(): UseGitCallbacks {
  return {
    refreshVault: vi.fn().mockResolvedValue(undefined),
    setActivePath: vi.fn(),
    setDocument: vi.fn<(doc: NoteDocument | null) => void>(),
    setDraft: vi.fn<(draft: string) => void>(),
    setViewMode: vi.fn(),
    setDistillTab: vi.fn(),
    setActiveUnresolvedTarget: vi.fn(),
    setSelectedUnresolvedTargets: vi.fn<(targets: Set<string>) => void>(),
    activePath: "Home.md",
    runUnresolvedLinksScan: vi.fn<() => Promise<UnresolvedLinkGroup[]>>().mockResolvedValue([]),
    draftStubNote: vi.fn<(target: string, sources: UnresolvedLinkSource[]) => Promise<void>>().mockResolvedValue(undefined),
  };
}

describe("useGit stash pull flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retains the stash state when pull failure rollback conflicts", async () => {
    vi.spyOn(vaultApi, "gitStashPush").mockResolvedValue("Saved working directory");
    vi.spyOn(vaultApi, "gitPull").mockRejectedValue(new Error("remote rejected pull"));
    vi.spyOn(vaultApi, "gitStashPop").mockResolvedValue({ status: "conflict", stashRef: "stash@{0}" });
    vi.spyOn(vaultApi, "getGitStatus").mockResolvedValue(gitStatus());
    vi.spyOn(vaultApi, "getGitChanges").mockResolvedValue([]);
    vi.spyOn(vaultApi, "gitMergeHeadExists").mockResolvedValue(true);

    const { result } = renderHook(() => useGit(callbacks()));

    await act(async () => {
      await result.current.handleStashAndPull();
    });

    await waitFor(() => {
      expect(result.current.stashRetainedRef).toBe("stash@{0}");
      expect(result.current.forceFreshConflictResolver).toBe(true);
      expect(result.current.gitOutputLog).toContain("Stash restore conflicted");
    });
  });
});

describe("useGit commit flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the commit output after commit and refresh both succeed", async () => {
    // Given: Git commit and both refresh stages succeed.
    const gitCommitSpy = vi.spyOn(vaultApi, "gitCommit").mockResolvedValue("Committed abc123");
    vi.spyOn(vaultApi, "getGitStatus").mockResolvedValue(gitStatus());
    const getChangesSpy = vi.spyOn(vaultApi, "getGitChanges")
      .mockResolvedValueOnce([{ path: "notes/test.md", staged: true, status: "modified" }])
      .mockResolvedValue([]);
    vi.spyOn(vaultApi, "gitMergeHeadExists").mockResolvedValue(false);
    const hookCallbacks = callbacks();
    const { result } = renderHook(() => useGit(hookCallbacks));

    // When: a non-empty commit message is submitted.
    let paths: string[] = [];
    await act(async () => {
      paths = await result.current.handleGitCommit("Freeze review contracts");
    });

    // Then: the exact message is committed, staged paths returned, success remains observable.
    expect(gitCommitSpy).toHaveBeenCalledWith("Freeze review contracts");
    expect(hookCallbacks.refreshVault).toHaveBeenCalledWith("Home.md");
    expect(result.current.gitOutputLog).toBe("Committed abc123");
    expect(result.current.isGitLoading).toBe(false);
    expect(paths).toEqual(["notes/test.md"]);
  });

  it("returns staged paths even when post-commit vault refresh fails", async () => {
    // Given: Git commit succeeds, but vault refresh fails afterward.
    const gitCommitSpy = vi.spyOn(vaultApi, "gitCommit").mockResolvedValue("Committed abc123");
    vi.spyOn(vaultApi, "getGitStatus").mockResolvedValue(gitStatus());
    vi.spyOn(vaultApi, "getGitChanges")
      .mockResolvedValueOnce([{ path: "notes/test.md", staged: true, status: "modified" }])
      .mockResolvedValue([]);
    vi.spyOn(vaultApi, "gitMergeHeadExists").mockResolvedValue(false);
    const hookCallbacks = callbacks();
    vi.mocked(hookCallbacks.refreshVault).mockRejectedValue(new Error("vault refresh failed"));
    const { result } = renderHook(() => useGit(hookCallbacks));

    // When: the commit completes before the vault refresh rejects.
    let paths: string[] = [];
    await act(async () => {
      paths = await result.current.handleGitCommit("Freeze review contracts");
    });

    // Then: commit succeeded — paths returned, refresh failure is a warning not a failure.
    expect(gitCommitSpy).toHaveBeenCalledWith("Freeze review contracts");
    expect(paths).toEqual(["notes/test.md"]);
    expect(result.current.gitOutputLog).toContain("Committed abc123");
    expect(result.current.gitOutputLog).toContain("Post-commit refresh");
    expect(result.current.isGitLoading).toBe(false);
  });
});
