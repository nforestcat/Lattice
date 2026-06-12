import { useState } from "react";
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

  async function refreshGitWorkspace(intendedSelection?: { path: string; staged: boolean }) {
    setIsGitLoading(true);
    try {
      const status = await vaultApi.getGitStatus();
      setGitStatus(status);
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
    } catch (err: any) {
      setGitOutputLog(`Error checking Git status: ${err?.message || err}`);
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
    } catch (err: any) {
      setGitOutputLog(`Error staging file ${path}: ${err?.message || err}`);
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
    } catch (err: any) {
      setGitOutputLog(`Error unstaging file ${path}: ${err?.message || err}`);
    } finally {
      setIsGitLoading(false);
    }
  }

  async function loadGitDiff(path: string, staged: boolean) {
    setActiveDiff(null);
    try {
      const diff = await vaultApi.getGitDiff(path, staged);
      setActiveDiff(diff);
    } catch (err: any) {
      setActiveDiff(`Error loading diff: ${err?.message || err}`);
    }
  }

  async function handleGitStageAll() {
    setIsGitLoading(true);
    try {
      await vaultApi.gitStageAll();
      setGitOutputLog("All changes staged.");
      await refreshGitWorkspace();
      await refreshVault(activePath);
    } catch (err: any) {
      setGitOutputLog(`Error staging changes: ${err?.message || err}`);
    } finally {
      setIsGitLoading(false);
    }
  }

  async function handleGitCommit(message: string) {
    if (!message.trim()) {
      setGitOutputLog("Error: Commit message cannot be empty.");
      return;
    }
    setIsGitLoading(true);
    try {
      const output = await vaultApi.gitCommit(message);
      setGitOutputLog(output);
      setCommitMessage("");
      setSelectedGitFile(null);
      setActiveDiff(null);
      await refreshGitWorkspace();
      await refreshVault(activePath);
    } catch (err: any) {
      setGitOutputLog(`Commit failed:\n${err?.message || err}`);
    } finally {
      setIsGitLoading(false);
    }
  }

  async function handleGitPull() {
    setIsGitLoading(true);
    try {
      setGitOutputLog("Pulling from remote repository...");
      const output = await vaultApi.gitPull();
      setGitOutputLog(output);
      await refreshGitWorkspace();
      await refreshVault(activePath);
    } catch (err: any) {
      setGitOutputLog(`Pull failed:\n${err?.message || err}`);
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
    } catch (err: any) {
      setGitOutputLog(`Push failed:\n${err?.message || err}`);
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
    handleGitPull,
    handleGitPush,
    openUnresolvedTarget,
    selectUnresolvedTarget,
    draftUnresolvedTarget,
    toggleAutoGit,
  };
}
