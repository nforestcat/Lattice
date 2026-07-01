import { describe, expect, it, vi } from "vitest";
import type { GitStatus, PullPreflight, StashPopResult } from "../src/api/types";
import { createGitPullOperations } from "../src/ui/hooks/gitPullOperations";

function gitStatus(): GitStatus {
  return {
    isRepo: true,
    autoGitEnabled: false,
    branch: "main",
    hasChanges: true,
    hasConflicts: false,
  };
}

describe("git pull operations", () => {
  it("retains stash state when pull failure restore conflicts", async () => {
    // Given: local changes were stashed, but pull fails and restoring them conflicts.
    const api = {
      gitPullPreflight: vi.fn(async (): Promise<PullPreflight> => ({
        isClean: true,
        dirtyFiles: [],
        hasConflicts: false,
      })),
      gitPull: vi.fn(async (): Promise<string> => {
        throw new Error("remote rejected pull");
      }),
      gitStashPush: vi.fn(async (): Promise<string> => "Saved working directory"),
      gitStashPop: vi.fn(async (_withIndex: boolean): Promise<StashPopResult> => ({
        status: "conflict",
        stashRef: "stash@{0}",
      })),
      gitStashDrop: vi.fn(async (): Promise<string> => "Dropped stash"),
    };
    let outputLog: string | null = null;
    let stashRetainedRef: string | null = null;
    let forceFreshConflictResolver = false;

    const operations = createGitPullOperations({
      api,
      activePath: "Home.md",
      gitStatus: gitStatus(),
      mergeHeadExists: false,
      stashRetainedRef,
      refreshGitWorkspace: vi.fn(async () => undefined),
      refreshVault: vi.fn(async () => undefined),
      setIsGitLoading: vi.fn(),
      setGitOutputLog: (value) => {
        outputLog = value;
      },
      setPendingPullWarning: vi.fn(),
      setStashRetainedRef: (value) => {
        stashRetainedRef = value;
      },
      setForceFreshConflictResolver: (value) => {
        forceFreshConflictResolver = value;
      },
    });

    // When: stash-and-pull runs through the rollback branch.
    await operations.handleStashAndPull();

    // Then: the retained stash is exposed for conflict resolution instead of dropped.
    expect(stashRetainedRef).toBe("stash@{0}");
    expect(forceFreshConflictResolver).toBe(true);
    expect(outputLog).toContain("Stash restore conflicted");
  });
});
