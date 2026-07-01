import type { GitCapability, GitFileChange, GitStatus } from "../../api/types";

type GitPullApi = Pick<
  GitCapability,
  "gitPullPreflight" | "gitPull" | "gitStashPush" | "gitStashPop" | "gitStashDrop"
>;

type Setter<T> = (value: T) => void;

export type GitPullOperationDeps = {
  readonly api: GitPullApi;
  readonly activePath: string | null;
  readonly gitStatus: GitStatus | null;
  readonly mergeHeadExists: boolean;
  readonly stashRetainedRef: string | null;
  readonly refreshGitWorkspace: () => Promise<void>;
  readonly refreshVault: (path: string | null) => Promise<void>;
  readonly setIsGitLoading: Setter<boolean>;
  readonly setGitOutputLog: Setter<string | null>;
  readonly setPendingPullWarning: Setter<{ dirtyFiles: GitFileChange[] } | null>;
  readonly setStashRetainedRef: Setter<string | null>;
  readonly setForceFreshConflictResolver: Setter<boolean>;
};

export type GitPullOperations = {
  readonly canDropStash: boolean;
  readonly handleGitPull: () => Promise<void>;
  readonly handlePullAnyway: () => Promise<void>;
  readonly cancelPendingPull: () => void;
  readonly handleStashAndPull: () => Promise<void>;
  readonly handleDropStash: () => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGitPullOperations(deps: GitPullOperationDeps): GitPullOperations {
  const {
    api,
    activePath,
    gitStatus,
    mergeHeadExists,
    stashRetainedRef,
    refreshGitWorkspace,
    refreshVault,
    setIsGitLoading,
    setGitOutputLog,
    setPendingPullWarning,
    setStashRetainedRef,
    setForceFreshConflictResolver,
  } = deps;

  async function handleGitPull() {
    setIsGitLoading(true);
    try {
      const preflight = await api.gitPullPreflight();
      if (!preflight.isClean) {
        setPendingPullWarning({ dirtyFiles: preflight.dirtyFiles });
        return;
      }
      await handlePullAnyway();
    } catch (err) {
      setGitOutputLog(`Pull preflight failed:\n${errorMessage(err)}`);
    } finally {
      setIsGitLoading(false);
    }
  }

  async function handlePullAnyway() {
    setIsGitLoading(true);
    try {
      setPendingPullWarning(null);
      setGitOutputLog("Pulling from remote repository...");
      const output = await api.gitPull();
      setGitOutputLog(output);
      await refreshGitWorkspace();
      await refreshVault(activePath);
    } catch (err) {
      setGitOutputLog(`Pull failed:\n${errorMessage(err)}`);
    } finally {
      setIsGitLoading(false);
    }
  }

  function cancelPendingPull() {
    setPendingPullWarning(null);
  }

  async function handleStashAndPull() {
    setIsGitLoading(true);
    try {
      setPendingPullWarning(null);
      setGitOutputLog("Stashing local changes...");
      await api.gitStashPush();
    } catch (err) {
      setGitOutputLog(`Stash failed, pull aborted:\n${errorMessage(err)}`);
      setIsGitLoading(false);
      return;
    }

    try {
      setGitOutputLog("Pulling from remote repository...");
      const pullOutput = await api.gitPull();

      const popResult = await api.gitStashPop(false);
      if (popResult.status === "clean") {
        setGitOutputLog(`${pullOutput}\nStash applied cleanly.`);
        setStashRetainedRef(null);
      } else {
        setStashRetainedRef(popResult.stashRef);
        setForceFreshConflictResolver(true);
        setGitOutputLog(`${pullOutput}\nStash pop conflicted — stash retained as ${popResult.stashRef}.`);
      }
      await refreshGitWorkspace();
      await refreshVault(activePath);
    } catch (pullErr) {
      try {
        const restoreResult = await api.gitStashPop(true);
        if (restoreResult.status === "clean") {
          setStashRetainedRef(null);
          setGitOutputLog(`Pull failed:\n${errorMessage(pullErr)}\nStashed changes restored.`);
        } else {
          const retainedRef = restoreResult.stashRef ?? "autostash entry";
          setStashRetainedRef(retainedRef);
          setForceFreshConflictResolver(true);
          setGitOutputLog(`Pull failed:\n${errorMessage(pullErr)}\nStash restore conflicted — stash retained as ${retainedRef}.`);
        }
      } catch (popErr) {
        setGitOutputLog(`Pull failed:\n${errorMessage(pullErr)}\nAlso failed to restore stash:\n${errorMessage(popErr)}`);
      }
      await refreshGitWorkspace();
    } finally {
      setIsGitLoading(false);
    }
  }

  async function handleDropStash() {
    if (gitStatus?.hasConflicts || mergeHeadExists) return;
    setIsGitLoading(true);
    try {
      await api.gitStashDrop();
      setStashRetainedRef(null);
      setGitOutputLog("Stash dropped.");
    } catch (err) {
      setGitOutputLog(`Failed to drop stash:\n${errorMessage(err)}`);
    } finally {
      setIsGitLoading(false);
    }
  }

  return {
    canDropStash: !!stashRetainedRef && !gitStatus?.hasConflicts && !mergeHeadExists,
    handleGitPull,
    handlePullAnyway,
    cancelPendingPull,
    handleStashAndPull,
    handleDropStash,
  };
}
