import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitWorkspace } from "../src/ui/components/GitWorkspace";
import type { GitStatus } from "../src/api/types";

function baseProps(overrides: Partial<Parameters<typeof GitWorkspace>[0]> = {}) {
  const gitStatus: GitStatus = {
    isRepo: true,
    autoGitEnabled: false,
    branch: "main",
    hasChanges: false,
    hasConflicts: false
  };

  return {
    gitStatus,
    gitChanges: [],
    selectedGitFile: null,
    selectedGitFileStaged: false,
    activeDiff: null,
    commitMessage: "",
    isGitLoading: false,
    gitOutputLog: null,
    setCommitMessage: vi.fn(),
    setSelectedGitFile: vi.fn(),
    setSelectedGitFileStaged: vi.fn(),
    setGitOutputLog: vi.fn(),
    onRefreshGit: vi.fn().mockResolvedValue(undefined),
    onStageAll: vi.fn().mockResolvedValue(undefined),
    onStageFile: vi.fn().mockResolvedValue(undefined),
    onUnstageFile: vi.fn().mockResolvedValue(undefined),
    onCommit: vi.fn().mockResolvedValue(undefined),
    onSuggestCommitMessage: vi.fn().mockResolvedValue(undefined),
    onPull: vi.fn().mockResolvedValue(undefined),
    onPush: vi.fn().mockResolvedValue(undefined),
    onLoadDiff: vi.fn().mockResolvedValue(undefined),
    pendingPullWarning: null,
    stashRetainedRef: "stash@{0}",
    canDropStash: false,
    onPullAnyway: vi.fn().mockResolvedValue(undefined),
    onCancelPendingPull: vi.fn(),
    onStashAndPull: vi.fn().mockResolvedValue(undefined),
    onDropStash: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe("GitWorkspace Drop-stash gating", () => {
  it("disables Drop stash while conflicts are unresolved or MERGE_HEAD exists", () => {
    render(
      <GitWorkspace
        {...baseProps({
          gitStatus: { isRepo: true, autoGitEnabled: false, branch: "main", hasChanges: true, hasConflicts: true },
          canDropStash: false
        })}
      />
    );

    const dropButton = screen.getByRole("button", { name: "Drop stash" }) as HTMLButtonElement;
    expect(dropButton.disabled).toBe(true);
  });

  it("enables Drop stash once conflicts are resolved and the merge is committed", () => {
    render(
      <GitWorkspace
        {...baseProps({
          gitStatus: { isRepo: true, autoGitEnabled: false, branch: "main", hasChanges: false, hasConflicts: false },
          canDropStash: true
        })}
      />
    );

    const dropButton = screen.getByRole("button", { name: "Drop stash" }) as HTMLButtonElement;
    expect(dropButton.disabled).toBe(false);
  });

  it("does not render the stash-retained banner when there is no retained stash", () => {
    render(<GitWorkspace {...baseProps({ stashRetainedRef: null })} />);
    expect(screen.queryByRole("button", { name: "Drop stash" })).toBeNull();
  });

  it("renders the pending-pull warning card with dirty files and wires the action buttons", () => {
    const onStashAndPull = vi.fn().mockResolvedValue(undefined);
    render(
      <GitWorkspace
        {...baseProps({
          stashRetainedRef: null,
          pendingPullWarning: { dirtyFiles: [{ path: "note.md", status: "untracked", staged: false }] },
          onStashAndPull
        })}
      />
    );

    expect(screen.getByText("note.md")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stash & Pull" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pull anyway" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});
