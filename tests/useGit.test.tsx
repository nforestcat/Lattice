import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultApi } from "../src/api";
import type { GitStatus, NoteDocument, UnresolvedLinkGroup, UnresolvedLinkSource } from "../src/api/types";
import { useGit, type UseGitCallbacks } from "../src/ui/hooks/useGit";
import type { UnresolvedLinksState } from "../src/ui/hooks/useUnresolvedLinks";

function gitStatus(): GitStatus {
  return {
    isRepo: true,
    autoGitEnabled: false,
    branch: "main",
    hasChanges: false,
    hasConflicts: false,
  };
}

function mockUnresolved(): UnresolvedLinksState {
  return {
    unresolvedLinks: [],
    setUnresolvedLinks: vi.fn(),
    isScanningUnresolved: false,
    setIsScanningUnresolved: vi.fn(),
    selectedUnresolvedTargets: new Set<string>(),
    setSelectedUnresolvedTargets: vi.fn(),
    activeUnresolvedTarget: null,
    setActiveUnresolvedTarget: vi.fn(),
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
    activePath: "Home.md",
    runUnresolvedLinksScan: vi.fn<() => Promise<UnresolvedLinkGroup[]>>().mockResolvedValue([]),
    draftStubNote: vi.fn<(target: string, sources: UnresolvedLinkSource[]) => Promise<void>>().mockResolvedValue(undefined),
    unresolved: mockUnresolved(),
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

  it("shares one promise when the same commit message fires twice concurrently", async () => {
    let resolveCommit: (value: string) => void;
    const commitPromise = new Promise<string>((r) => { resolveCommit = r; });
    const gitCommitSpy = vi.spyOn(vaultApi, "gitCommit").mockReturnValue(commitPromise);
    vi.spyOn(vaultApi, "getGitStatus").mockResolvedValue(gitStatus());
    vi.spyOn(vaultApi, "getGitChanges")
      .mockResolvedValue([{ path: "notes/a.md", staged: true, status: "modified" }]);
    vi.spyOn(vaultApi, "gitMergeHeadExists").mockResolvedValue(false);
    const { result } = renderHook(() => useGit(callbacks()));

    let paths1: string[] = [];
    let paths2: string[] = [];
    await act(async () => {
      const p1 = result.current.handleGitCommit("same msg");
      const p2 = result.current.handleGitCommit("same msg");
      resolveCommit!("Committed ok");
      paths1 = await p1;
      paths2 = await p2;
    });

    expect(gitCommitSpy).toHaveBeenCalledTimes(1);
    expect(paths1).toEqual(["notes/a.md"]);
    expect(paths2).toEqual(["notes/a.md"]);
  });

  it("returns empty paths when a different commit message fires during in-flight commit", async () => {
    let resolveCommit: (value: string) => void;
    const commitPromise = new Promise<string>((r) => { resolveCommit = r; });
    const gitCommitSpy = vi.spyOn(vaultApi, "gitCommit").mockReturnValue(commitPromise);
    vi.spyOn(vaultApi, "getGitStatus").mockResolvedValue(gitStatus());
    vi.spyOn(vaultApi, "getGitChanges")
      .mockResolvedValue([{ path: "notes/a.md", staged: true, status: "modified" }]);
    vi.spyOn(vaultApi, "gitMergeHeadExists").mockResolvedValue(false);
    const { result } = renderHook(() => useGit(callbacks()));

    let paths1: string[] = [];
    let paths2: string[] = [];
    await act(async () => {
      const p1 = result.current.handleGitCommit("first msg");
      const p2 = result.current.handleGitCommit("different msg");
      resolveCommit!("Committed ok");
      paths1 = await p1;
      paths2 = await p2;
    });

    expect(gitCommitSpy).toHaveBeenCalledTimes(1);
    expect(paths1).toEqual(["notes/a.md"]);
    expect(paths2).toEqual([]);
  });

  it("allows sequential commits after the first completes", async () => {
    const gitCommitSpy = vi.spyOn(vaultApi, "gitCommit")
      .mockResolvedValueOnce("Committed 1")
      .mockResolvedValueOnce("Committed 2");
    vi.spyOn(vaultApi, "getGitStatus").mockResolvedValue(gitStatus());
    vi.spyOn(vaultApi, "getGitChanges")
      .mockResolvedValue([{ path: "notes/a.md", staged: true, status: "modified" }]);
    vi.spyOn(vaultApi, "gitMergeHeadExists").mockResolvedValue(false);
    const { result } = renderHook(() => useGit(callbacks()));

    let paths1: string[] = [];
    let paths2: string[] = [];
    await act(async () => {
      paths1 = await result.current.handleGitCommit("first");
    });
    await act(async () => {
      paths2 = await result.current.handleGitCommit("second");
    });

    expect(gitCommitSpy).toHaveBeenCalledTimes(2);
    expect(paths1).toEqual(["notes/a.md"]);
    expect(paths2).toEqual(["notes/a.md"]);
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
