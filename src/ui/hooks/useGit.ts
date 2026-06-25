import { useState, useRef } from "react";
import { vaultApi } from "../../api";
import type { GitStatus, GitFileChange, NoteDocument, UnresolvedLinkGroup, UnresolvedLinkSource } from "../../api/types";

type ViewMode = "split" | "edit" | "preview" | "graph" | "distill";
type DistillTab = "paste" | "chat" | "auditor" | "git";

export interface UseGitCallbacks {
  refreshVault: (path: string | null) => Promise<void>;
  setActivePath: (path: string | null) => void;
  setDocument: (doc: NoteDocument | null) => void;
  setDraft: (draft: string) => void;
  setViewMode: (mode: ViewMode) => void;
  setDistillTab: (tab: DistillTab) => void;
  setActiveUnresolvedTarget: (target: string | null) => void;
  setSelectedUnresolvedTargets: (targets: Set<string>) => void;
  activePath: string | null;
  runUnresolvedLinksScan: () => Promise<UnresolvedLinkGroup[]>;
  draftStubNote: (target: string, sources: UnresolvedLinkSource[]) => Promise<void>;
}

function normalizeRef(value: string): string {
  return value.replace(/\\/g, "/").replace(/\.md$/i, "").trim().toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useGit(callbacks: UseGitCallbacks) {
  const {
    refreshVault,
    setActivePath,
    setDocument,
    setDraft,
    setViewMode,
    setDistillTab,
    setActiveUnresolvedTarget,
    setSelectedUnresolvedTargets,
    activePath,
    runUnresolvedLinksScan,
    draftStubNote,
  } = callbacks;

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitChanges, setGitChanges] = useState<GitFileChange[]>([]);
  const [selectedGitFile, setSelectedGitFile] = useState<string | null>(null);
  const [selectedGitFileStaged, setSelectedGitFileStaged] = useState<boolean>(false);
  const [activeDiff, setActiveDiff] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState<string>("");
  const [isGitLoading, setIsGitLoading] = useState<boolean>(false);
  const [gitOutputLog, setGitOutputLog] = useState<string | null>(null);
  const [auditorSubTab, setAuditorSubTab] = useState<"health" | "links">("health");
  const [unresolvedLinks, setUnresolvedLinks] = useState<UnresolvedLinkGroup[]>([]);
  const [isScanningUnresolved, setIsScanningUnresolved] = useState(false);
  const [pendingPullWarning, setPendingPullWarning] = useState<{ dirtyFiles: GitFileChange[] } | null>(null);
  const [stashRetainedRef, setStashRetainedRef] = useState<string | null>(null);
  const [mergeHeadExists, setMergeHeadExists] = useState<boolean>(false);
  const [forceFreshConflictResolver, setForceFreshConflictResolver] = useState<boolean>(false);
  const gitRequestCounter = useRef(0);

  async function refreshGitWorkspace(intendedSelection?: { path: string; staged: boolean }) {
    const requestId = ++gitRequestCounter.current;
    setIsGitLoading(true);
    try {
      const status = await vaultApi.getGitStatus();
      if (gitRequestCounter.current !== requestId) return;
      setGitStatus(status);
      void refreshMergeHeadExists();
      if (status.isRepo) {
        const changes = await vaultApi.getGitChanges();
        setGitChanges(changes);
        const target = intendedSelection || (selectedGitFile ? { path: selectedGitFile, staged: selectedGitFileStaged } : null);
        if (target) {
          const match = changes.find(c => c.path === target.path && c.staged === target.staged);
          if (match) {
            setSelectedGitFile(match.path);
            setSelectedGitFileStaged(match.staged);
            void loadGitDiff(match.path, match.staged);
          } else {
            setSelectedGitFile(null);
            setSelectedGitFileStaged(false);
            setActiveDiff(null);
          }
        } else {
          setSelectedGitFile(null);
          setSelectedGitFileStaged(false);
          setActiveDiff(null);
        }
      } else {
        setGitChanges([]);
        setSelectedGitFile(null);
        setSelectedGitFileStaged(false);
        setActiveDiff(null);
      }
    } catch (err) {
      setGitOutputLog(`Error checking Git status: ${errorMessage(err)}`);
    } finally {
      setIsGitLoading(false);
    }
  }

  async function handleGitStageFile(path: string) {
    setIsGitLoading(true);
    try {
      await vaultApi.gitStageFile(path);
      if (selectedGitFile === path) {
        setSelectedGitFileStaged(true);
      }
      await refreshGitWorkspace({ path, staged: true });
      await refreshVault(activePath);
    } catch (err) {
      setGitOutputLog(`Error staging file ${path}: ${errorMessage(err)}`);
    } finally {
      setIsGitLoading(false);
    }
  }

  async function handleGitUnstageFile(path: string) {
    setIsGitLoading(true);
    try {
      await vaultApi.gitUnstageFile(path);
      if (selectedGitFile === path) {
        setSelectedGitFileStaged(false);
      }
      await refreshGitWorkspace({ path, staged: false });
      await refreshVault(activePath);
    } catch (err) {
      setGitOutputLog(`Error unstaging file ${path}: ${errorMessage(err)}`);
    } finally {
      setIsGitLoading(false);
    }
  }

  async function loadGitDiff(path: string, staged: boolean) {
    setActiveDiff(null);
    try {
      const diff = await vaultApi.getGitDiff(path, staged);
      if (selectedGitFile !== path) return;
      setActiveDiff(diff);
    } catch (err) {
      if (selectedGitFile !== path) return;
      setActiveDiff(`Error loading diff: ${errorMessage(err)}`);
    }
  }

  async function handleGitStageAll() {
    setIsGitLoading(true);
    try {
      await vaultApi.gitStageAll();
      setGitOutputLog("All changes staged.");
      await refreshGitWorkspace();
      await refreshVault(activePath);
    } catch (err) {
      setGitOutputLog(`Error staging changes: ${errorMessage(err)}`);
    } finally {
      setIsGitLoading(false);
    }
  }

  // ponytail: returns normalized staged paths on success, empty on failure
  async function handleGitCommit(message: string): Promise<string[]> {
    if (!message.trim()) {
      setGitOutputLog("Error: Commit message cannot be empty.");
      return [];
    }
    setIsGitLoading(true);
    try {
      const changes = await vaultApi.getGitChanges();
      const stagedPaths = changes
        .filter((c) => c.staged)
        .map((c) => c.path.replace(/\\/g, "/"));
      if (stagedPaths.length === 0) {
        setGitOutputLog("Nothing staged to commit.");
        setIsGitLoading(false);
        return [];
      }
      const output = await vaultApi.gitCommit(message);
      setGitOutputLog(output);
      setCommitMessage("");
      setSelectedGitFile(null);
      setActiveDiff(null);
      // ponytail: refresh failure after successful commit is non-fatal
      try {
        await refreshGitWorkspace();
        await refreshVault(activePath);
      } catch (refreshErr) {
        setGitOutputLog(`${output}\n⚠ Post-commit refresh: ${errorMessage(refreshErr)}`);
      }
      return stagedPaths;
    } catch (err) {
      setGitOutputLog(`Commit failed:\n${errorMessage(err)}`);
      return [];
    } finally {
      setIsGitLoading(false);
    }
  }

  async function handleSuggestCommitMessage() {
    if (commitMessage.trim()) return;
    try {
      const msg = await vaultApi.gitSuggestCommitMessage();
      setCommitMessage(msg);
    } catch (err) {
      setGitOutputLog(`Could not suggest commit message: ${errorMessage(err)}`);
    }
  }

  async function refreshMergeHeadExists() {
    try {
      const exists = await vaultApi.gitMergeHeadExists();
      setMergeHeadExists(exists);
      return exists;
    } catch {
      return false;
    }
  }

  async function handleGitPull() {
    setIsGitLoading(true);
    try {
      const preflight = await vaultApi.gitPullPreflight();
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
      const output = await vaultApi.gitPull();
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
      await vaultApi.gitStashPush();
    } catch (err) {
      setGitOutputLog(`Stash failed, pull aborted:\n${errorMessage(err)}`);
      setIsGitLoading(false);
      return;
    }

    try {
      setGitOutputLog("Pulling from remote repository...");
      const pullOutput = await vaultApi.gitPull();

      const popResult = await vaultApi.gitStashPop(false);
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
        const restoreResult = await vaultApi.gitStashPop(true);
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
      await vaultApi.gitStashDrop();
      setStashRetainedRef(null);
      setGitOutputLog("Stash dropped.");
    } catch (err) {
      setGitOutputLog(`Failed to drop stash:\n${errorMessage(err)}`);
    } finally {
      setIsGitLoading(false);
    }
  }

  async function handleGitPush() {
    setIsGitLoading(true);
    try {
      setGitOutputLog("Pushing to remote repository...");
      const output = await vaultApi.gitPush();
      setGitOutputLog(output);
      await refreshGitWorkspace();
      await refreshVault(activePath);
    } catch (err) {
      setGitOutputLog(`Push failed:\n${errorMessage(err)}`);
    } finally {
      setIsGitLoading(false);
    }
  }

  function openUnresolvedTarget(normalizedTargetRef: string) {
    setActiveUnresolvedTarget(normalizedTargetRef);
    setActivePath(null);
    setDocument(null);
    setDraft("");
    setViewMode("distill");
    setDistillTab("auditor");
    setAuditorSubTab("links");

    const group = unresolvedLinks.find(g => normalizeRef(g.target).trim() === normalizedTargetRef);
    const displayName = group ? group.target : normalizedTargetRef;
    setSelectedUnresolvedTargets(new Set([displayName]));
  }

  function selectUnresolvedTarget(normalizedTargetRef: string) {
    setActiveUnresolvedTarget(normalizedTargetRef);
    setActivePath(null);
    setDocument(null);
    setDraft("");
  }

  async function draftUnresolvedTarget(normalizedTargetRef: string) {
    let currentLinks = unresolvedLinks;
    if (currentLinks.length === 0) {
      currentLinks = await runUnresolvedLinksScan();
    }
    const item = currentLinks.find(x => normalizeRef(x.target).trim() === normalizedTargetRef);
    if (item) {
      void draftStubNote(item.target, item.sources);
    }
    openUnresolvedTarget(normalizedTargetRef);
  }

  async function toggleAutoGit(enabled: boolean) {
    await vaultApi.setAutoGit(enabled);
    setGitStatus(await vaultApi.getGitStatus());
  }

  const canDropStash = !!stashRetainedRef && !gitStatus?.hasConflicts && !mergeHeadExists;

  return {
    gitStatus, setGitStatus,
    gitChanges, setGitChanges,
    selectedGitFile, setSelectedGitFile,
    selectedGitFileStaged, setSelectedGitFileStaged,
    activeDiff, setActiveDiff,
    commitMessage, setCommitMessage,
    isGitLoading,
    gitOutputLog, setGitOutputLog,
    auditorSubTab, setAuditorSubTab,
    unresolvedLinks, setUnresolvedLinks,
    isScanningUnresolved, setIsScanningUnresolved,
    refreshGitWorkspace,
    handleGitStageFile,
    handleGitUnstageFile,
    loadGitDiff,
    handleGitStageAll,
    handleGitCommit,
    handleSuggestCommitMessage,
    handleGitPull,
    handleGitPush,
    pendingPullWarning,
    stashRetainedRef,
    mergeHeadExists,
    forceFreshConflictResolver, setForceFreshConflictResolver,
    canDropStash,
    handlePullAnyway,
    cancelPendingPull,
    handleStashAndPull,
    handleDropStash,
    openUnresolvedTarget,
    selectUnresolvedTarget,
    draftUnresolvedTarget,
    toggleAutoGit,
  };
}
