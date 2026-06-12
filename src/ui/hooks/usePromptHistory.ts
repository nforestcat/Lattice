import { useState } from "react";
import { vaultApi } from "../../api";
import { askConfirm } from "../../api/dialog";
import type { ContextBundle, PromptRun, VaultConfig } from "../../api/types";
import {
  type PresetType,
  VAULT_CONFIG_VERSION,
  normalizeLegacyPreset,
  buildCombinedPrompt,
  sanitizeVaultConfig,
  errorMessage,
} from "./contextShared";

export interface DiffLine {
  type: "added" | "removed" | "normal";
  value: string;
}

function computeSimpleLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  const dp: number[][] = [];
  const n = Math.min(oldLines.length, 1000);
  const m = Math.min(newLines.length, 1000);

  for (let i = 0; i <= n; i++) {
    dp[i] = new Array(m + 1).fill(0);
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result: DiffLine[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: "normal", value: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: "added", value: newLines[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i - 1][j] >= dp[i][j - 1])) {
      result.push({ type: "removed", value: oldLines[i - 1] });
      i--;
    }
  }

  if (oldLines.length > n || newLines.length > m) {
    result.reverse();
    result.push({ type: "normal", value: "... [Diff truncated for performance, showing first 1000 lines] ..." });
    return result;
  }

  return result.reverse();
}

export interface UsePromptHistoryCallbacks {
  vaultConfig: VaultConfig;
  vaultConfigRef: React.MutableRefObject<VaultConfig>;
  setVaultConfig: React.Dispatch<React.SetStateAction<VaultConfig>>;
  updateVaultConfig: (updates: Partial<VaultConfig>) => Promise<void>;
  setStatus: (status: string) => void;
  selectNote: (path: string, currentConfig?: VaultConfig) => Promise<void>;
  contextBundle: ContextBundle | null;
  setContextBundle: (bundle: ContextBundle | null) => void;
  setPrevContextBundle: (bundle: ContextBundle | null) => void;
  setBundlePreset: (preset: PresetType) => void;
  setBundlePurpose: (purpose: string) => void;
  setBundleMode: (mode: "short" | "standard" | "full") => void;
  promptInstruction: string;
  refreshArchiveStatus: () => void;
}

export function usePromptHistory(callbacks: UsePromptHistoryCallbacks) {
  const {
    vaultConfig,
    vaultConfigRef,
    setVaultConfig,
    updateVaultConfig,
    setStatus,
    selectNote,
    contextBundle,
    setContextBundle,
    setPrevContextBundle,
    setBundlePreset,
    setBundlePurpose,
    setBundleMode,
    promptInstruction,
    refreshArchiveStatus,
  } = callbacks;

  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [diffRunId, setDiffRunId] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<{ lines: DiffLine[]; regenerating: boolean; error?: string } | null>(null);
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [historyActiveNoteOnly, setHistoryActiveNoteOnly] = useState(false);
  const [historyPresetFilter, setHistoryPresetFilter] = useState("");

  async function applyPromptRun(run: PromptRun) {
    try {
      const currentSelected = vaultConfigRef.current.selectedPaths ?? {};
      const currentPrompts = vaultConfigRef.current.promptInstructions ?? {};
      const presetForUi = normalizeLegacyPreset(run.preset);

      const nextConfig: VaultConfig = sanitizeVaultConfig({
        ...vaultConfigRef.current,
        version: VAULT_CONFIG_VERSION,
        bundlePreset: presetForUi,
        bundlePurpose: run.purpose,
        bundleMode: run.mode,
        selectedPaths: {
          ...currentSelected,
          [run.activePath]: run.selectedNotes
        },
        promptInstructions: {
          ...currentPrompts,
          [run.activePath]: run.question
        }
      });

      vaultConfigRef.current = nextConfig;
      setVaultConfig(nextConfig);
      setBundlePreset(presetForUi);
      setBundlePurpose(run.purpose);
      setBundleMode(run.mode);
      await vaultApi.saveVaultConfig(nextConfig);

      await selectNote(run.activePath, nextConfig);

      const bundle = await vaultApi.getContextBundle(run.activePath, {
        selectedPaths: run.selectedNotes,
        purpose: run.purpose,
        mode: run.mode,
        preset: run.preset
      });
      setPrevContextBundle(contextBundle);
      setContextBundle(bundle);
      setStatus(`Loaded history prompt from ${new Date(run.createdAt).toLocaleString()}`);
    } catch (e) {
      setStatus(errorMessage(e));
    }
  }

  async function copyPromptRunQuestion(run: PromptRun) {
    if (!run.question) {
      setStatus("No question to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(run.question);
      setStatus("Question copied to clipboard");
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function copyFullPromptFromHistory(run: PromptRun) {
    try {
      setStatus("Retrieving archived prompt...");
      let promptContent = "";
      try {
        promptContent = await vaultApi.getArchivedPrompt(run.id);
      } catch (e) {
        console.warn("Archived prompt not found, falling back to regeneration", e);
      }

      if (promptContent) {
        await navigator.clipboard.writeText(promptContent);
        setStatus(`Copied archived prompt for ${run.activePath.split('/').pop() || run.activePath} from history!`);
      } else {
        setStatus("Regenerating historical prompt...");
        const bundle = await vaultApi.getContextBundle(run.activePath, {
          selectedPaths: run.selectedNotes,
          purpose: run.purpose ?? "",
          mode: run.mode,
          preset: run.preset
        });
        const combined = run.question.trim()
          ? `${run.question.trim()}\n\n---\n\n${bundle.markdown}`
          : bundle.markdown;
        await navigator.clipboard.writeText(combined);
        setStatus(`Copied regenerated prompt for ${run.activePath.split('/').pop() || run.activePath} from history!`);
      }
    } catch (err) {
      setStatus(errorMessage(err));
    }
  }

  async function deletePromptRun(runId: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!(await askConfirm("Delete this prompt history entry and its archived prompt?", "Delete Prompt Run"))) {
      return;
    }

    try {
      await vaultApi.deleteArchivedPrompt(runId);
      const nextRuns = (vaultConfig.promptRuns ?? []).filter((r) => r.id !== runId);
      await updateVaultConfig({ promptRuns: nextRuns });
      refreshArchiveStatus();
      setStatus("Deleted prompt run history entry");
      if (expandedRunId === runId) {
        setExpandedRunId(null);
      }
      if (diffRunId === runId) {
        setDiffRunId(null);
        setDiffResult(null);
      }
    } catch (err) {
      setStatus(errorMessage(err));
    }
  }

  async function pruneArchivedPrompts() {
    if (!(await askConfirm("Prune archived prompt files that no longer have history entries?", "Prune Prompt Archives"))) {
      return;
    }

    try {
      const activeRunIds = (vaultConfig.promptRuns ?? []).map((r) => r.id);
      await vaultApi.pruneArchivedPrompts(activeRunIds);
      refreshArchiveStatus();
      setStatus("Pruned orphaned prompt archives");
    } catch (err) {
      setStatus(errorMessage(err));
    }
  }

  async function pruneExpiredPromptRuns(policy: string, currentConfig = vaultConfig, showConfirm = true) {
    if (policy === "none" || !policy) {
      if (showConfirm) {
        setStatus("No retention policy selected. Select a retention period first.");
      }
      return;
    }

    const daysLimit = Number(policy);
    if (!Number.isFinite(daysLimit)) return;

    const runs = currentConfig.promptRuns ?? [];
    const now = Date.now();
    const msLimit = daysLimit * 24 * 60 * 60 * 1000;

    const expired = runs.filter((run) => {
      if (!run.createdAt) return false;
      const age = now - new Date(run.createdAt).getTime();
      return age > msLimit;
    });

    if (expired.length === 0) {
      if (showConfirm) {
        setStatus("No expired prompt runs found to prune.");
      }
      return;
    }

    if (showConfirm) {
      const confirmed = await askConfirm(
        `Prune ${expired.length} prompt run(s) older than ${policy} days? This will delete their markdown files from disk.`,
        "Prune Expired Prompt Runs"
      );
      if (!confirmed) return;
    }

    try {
      for (const run of expired) {
        await vaultApi.deleteArchivedPrompt(run.id);
      }

      const nextRuns = runs.filter((run) => {
        if (!run.createdAt) return true;
        const age = now - new Date(run.createdAt).getTime();
        return age <= msLimit;
      });

      const updated = sanitizeVaultConfig({
        ...currentConfig,
        promptRuns: nextRuns
      });

      await vaultApi.saveVaultConfig(updated);
      setVaultConfig(updated);
      vaultConfigRef.current = updated;

      const activeRunIds = nextRuns.map((r) => r.id);
      await vaultApi.pruneArchivedPrompts(activeRunIds);

      refreshArchiveStatus();
      setStatus(`Pruned ${expired.length} expired prompt run(s)`);
    } catch (err) {
      console.error(err);
      setStatus("Failed to prune expired prompt runs");
    }
  }

  async function exportPromptRuns() {
    const runs = vaultConfig.promptRuns ?? [];
    if (runs.length === 0) {
      setStatus("No prompt runs in history to export");
      return;
    }

    setStatus("Exporting prompt runs...");
    try {
      const exportedItems = [];
      for (const run of runs) {
        try {
          const content = await vaultApi.getArchivedPrompt(run.id);
          exportedItems.push({
            metadata: run,
            content
          });
        } catch (err) {
          console.error(`Failed to read prompt run ${run.id} content for export`, err);
          exportedItems.push({
            metadata: run,
            content: ""
          });
        }
      }

      const payload = {
        exportVersion: 1,
        exportedAt: new Date().toISOString(),
        promptRuns: exportedItems
      };

      const jsonStr = JSON.stringify(payload, null, 2);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      const a = window.document.createElement("a");
      a.href = url;
      a.download = `lattice-prompt-archive-${new Date().toISOString().split('T')[0]}.json`;
      window.document.body.appendChild(a);
      a.click();
      window.document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setStatus(`Exported ${runs.length} prompt run(s) successfully`);
    } catch (err) {
      console.error(err);
      setStatus("Export failed");
    }
  }

  async function handleImportArchiveFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setStatus("Reading archive file...");
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const text = e.target?.result as string;
        const data = JSON.parse(text);
        if (!data || data.exportVersion !== 1 || !Array.isArray(data.promptRuns)) {
          setStatus("Import failed: Invalid archive format");
          return;
        }

        const importedItems = data.promptRuns;
        if (importedItems.length === 0) {
          setStatus("Archive contains no prompt runs");
          return;
        }

        const currentRuns = vaultConfig.promptRuns ?? [];
        const currentIds = new Set(currentRuns.map((r) => r.id));

        let newCount = 0;
        const nextRuns = [...currentRuns];

        for (const item of importedItems) {
          const run = item.metadata;
          if (!run || !run.id) continue;

          if (!currentIds.has(run.id)) {
            nextRuns.push(run);
            newCount++;
          }

          if (item.content) {
            await vaultApi.archivePromptRun(run.id, item.content);
          }
        }

        if (newCount > 0) {
          nextRuns.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

          await updateVaultConfig({
            ...vaultConfig,
            promptRuns: nextRuns
          });
          setStatus(`Imported ${newCount} new prompt run(s) successfully`);
          refreshArchiveStatus();
        } else {
          setStatus("All prompt runs in the archive already exist in the history");
        }
      } catch (err) {
        console.error(err);
        setStatus("Import failed: JSON parsing error");
      }
    };
    reader.onerror = () => {
      setStatus("Import failed: File reading error");
    };
    reader.readAsText(file);
    event.target.value = "";
  }

  async function loadPromptDiff(run: PromptRun) {
    if (diffRunId === run.id) {
      setDiffRunId(null);
      setDiffResult(null);
      return;
    }

    setDiffRunId(run.id);
    setDiffResult({ lines: [], regenerating: true });

    try {
      if (!contextBundle) {
        setDiffResult({
          lines: [],
          regenerating: false,
          error: "Current context bundle not loaded. Try generating a bundle first."
        });
        return;
      }
      const currentCombined = buildCombinedPrompt(promptInstruction, contextBundle.markdown);

      let oldPrompt = "";
      try {
        oldPrompt = await vaultApi.getArchivedPrompt(run.id);
      } catch (err) {
        console.warn("Archived prompt not found for diff, falling back to dynamic regeneration", err);
      }

      if (!oldPrompt) {
        const bundle = await vaultApi.getContextBundle(run.activePath, {
          selectedPaths: run.selectedNotes,
          purpose: run.purpose ?? "",
          mode: run.mode,
          preset: run.preset
        });
        oldPrompt = run.question.trim()
          ? `${run.question.trim()}\n\n---\n\n${bundle.markdown}`
          : bundle.markdown;
      }

      const diffLines = computeSimpleLineDiff(oldPrompt, currentCombined);
      setDiffResult({ lines: diffLines, regenerating: false });
    } catch (e) {
      setDiffResult({ lines: [], regenerating: false, error: errorMessage(e) });
    }
  }

  return {
    expandedRunId, setExpandedRunId,
    diffRunId, setDiffRunId,
    diffResult, setDiffResult,
    historySearchQuery, setHistorySearchQuery,
    historyActiveNoteOnly, setHistoryActiveNoteOnly,
    historyPresetFilter, setHistoryPresetFilter,
    applyPromptRun,
    copyPromptRunQuestion,
    copyFullPromptFromHistory,
    deletePromptRun,
    pruneArchivedPrompts,
    pruneExpiredPromptRuns,
    exportPromptRuns,
    handleImportArchiveFile,
    loadPromptDiff,
  };
}
