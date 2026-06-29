import { useState } from "react";
import { vaultApi } from "../../api";
import type { ContextBundle, ContextBundleCandidate, PromptRun, VaultConfig } from "../../api/types";
import {
  PRESETS,
  type PresetType,
  normalizePreset,
  presetForSettings,
  buildCombinedPrompt,
  simplePromptHash,
  errorMessage,
} from "./contextShared";
import { pruneRecommendedCandidates } from "../contextPrune";

export interface UseContextBundleCallbacks {
  activePath: string | null;
  vaultConfig: VaultConfig;
  vaultConfigRef: React.MutableRefObject<VaultConfig>;
  promptInstruction: string;
  updateVaultConfig: (updates: Partial<VaultConfig>) => Promise<void>;
  setStatus: (status: string) => void;
  onArchiveChanged: () => void;
}

export function useContextBundle(callbacks: UseContextBundleCallbacks) {
  const {
    activePath,
    vaultConfigRef,
    promptInstruction,
    updateVaultConfig,
    setStatus,
    onArchiveChanged,
  } = callbacks;

  const [contextBundle, setContextBundle] = useState<ContextBundle | null>(null);
  const [prevContextBundle, setPrevContextBundle] = useState<ContextBundle | null>(null);
  const [contextCandidates, setContextCandidates] = useState<ContextBundleCandidate[]>([]);
  const [selectedContextPaths, setSelectedContextPaths] = useState<Set<string>>(new Set());
  const [bundlePreset, setBundlePreset] = useState<PresetType>("ask");
  const [bundlePurpose, setBundlePurpose] = useState(PRESETS["ask"].purpose);
  const [bundleMode, setBundleMode] = useState<"short" | "standard" | "full">("standard");
  const [contextLimit, setContextLimit] = useState<number>(8000);

  const handleLimitChange = (val: number) => {
    setContextLimit(val);
    void updateVaultConfig({ contextLimit: val });
  };

  async function generateContextBundle(overridePaths?: string[], overrideMode?: "short" | "standard" | "full", overridePreset?: PresetType) {
    if (!activePath) {
      return;
    }
    const capturedPath = activePath;
    try {
      const paths = overridePaths ?? contextCandidates.filter((candidate) => selectedContextPaths.has(candidate.path)).map((candidate) => candidate.path);
      const mode = overrideMode ?? bundleMode;
      const bundle = await vaultApi.getContextBundle(capturedPath, {
        selectedPaths: paths,
        purpose: bundlePurpose,
        mode,
        preset: overridePreset ?? bundlePreset
      });
      if (activePath !== capturedPath) return;
      setPrevContextBundle(contextBundle);
      setContextBundle(bundle);
      setStatus(`Context bundle includes ${bundle.notePaths.length} notes`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function autoPruneCandidates() {
    if (!activePath) return;
    let pruned;
    try {
      pruned = await pruneRecommendedCandidates({
        activePath,
        selectedContextPaths,
        contextCandidates,
        contextLimit,
        bundlePurpose,
        bundleMode,
        bundlePreset,
        getContextBundle: (path, options) => vaultApi.getContextBundle(path, options),
      });
    } catch (e) {
      setStatus(errorMessage(e));
      return;
    }

    setSelectedContextPaths(pruned.nextPaths);
    setContextBundle(pruned.currentBundle);

    if (activePath) {
      const currentSelected = vaultConfigRef.current.selectedPaths ?? {};
      const nextSelected = {
        ...currentSelected,
        [activePath]: Array.from(pruned.nextPaths)
      };
      void updateVaultConfig({ selectedPaths: nextSelected });
    }

    setStatus(pruned.status);
  }

  async function switchToShortMode() {
    setBundleMode("short");
    const nextPreset = presetForSettings(bundlePurpose, "short");
    setBundlePreset(nextPreset);
    void updateVaultConfig({ bundleMode: "short", bundlePreset: nextPreset });
    if (contextBundle) {
      await generateContextBundle(undefined, "short", nextPreset);
    }
  }

  const handlePresetChange = (preset: string) => {
    const nextPreset = normalizePreset(preset);
    setBundlePreset(nextPreset);
    if (nextPreset !== "custom") {
      const config = PRESETS[nextPreset];
      setBundlePurpose(config.purpose);
      setBundleMode(config.mode);
      void updateVaultConfig({
        bundlePreset: nextPreset,
        bundlePurpose: config.purpose,
        bundleMode: config.mode
      });
    } else {
      void updateVaultConfig({ bundlePreset: nextPreset });
    }
    setContextBundle(null);
  };

  function toggleContextCandidate(path: string) {
    const next = new Set(selectedContextPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    setSelectedContextPaths(next);

    if (activePath) {
      const currentSelected = vaultConfigRef.current.selectedPaths ?? {};
      const nextSelected = {
        ...currentSelected,
        [activePath]: Array.from(next)
      };
      void updateVaultConfig({ selectedPaths: nextSelected });
    }
    setContextBundle(null);
  }

  async function copyContextBundle() {
    if (!contextBundle) {
      return;
    }
    try {
      await navigator.clipboard.writeText(contextBundle.markdown);
      setStatus("Context bundle copied");
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function copyCombinedPrompt() {
    if (!contextBundle) {
      return;
    }
    const combined = buildCombinedPrompt(promptInstruction, contextBundle.markdown);
    try {
      await navigator.clipboard.writeText(combined);
      setStatus("Combined prompt copied");

      let promptHash = "";
      const preview = combined.slice(0, 1500) + (combined.length > 1500 ? "..." : "");
      const newId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11);

      // Archive the exact prompt content
      try {
        promptHash = await vaultApi.archivePromptRun(newId, combined);
        onArchiveChanged();
      } catch (archiveErr) {
        console.error("Failed to archive prompt run", archiveErr);
        promptHash = simplePromptHash(combined);
      }

      const newRun: PromptRun = {
        id: newId,
        question: promptInstruction.trim(),
        selectedNotes: contextBundle.notePaths,
        preset: bundlePreset,
        purpose: bundlePurpose,
        mode: bundleMode,
        tokenCount: contextBundle.estimatedTokens,
        createdAt: new Date().toISOString(),
        activePath: activePath || "",
        promptHash,
        preview
      };

      const currentRuns = vaultConfigRef.current.promptRuns ?? [];
      const nextRuns = [newRun, ...currentRuns].slice(0, 100);
      void updateVaultConfig({ promptRuns: nextRuns });
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  return {
    contextBundle, setContextBundle,
    prevContextBundle, setPrevContextBundle,
    contextCandidates, setContextCandidates,
    selectedContextPaths, setSelectedContextPaths,
    bundlePreset, setBundlePreset,
    bundlePurpose, setBundlePurpose,
    bundleMode, setBundleMode,
    contextLimit, setContextLimit,
    generateContextBundle,
    autoPruneCandidates,
    switchToShortMode,
    toggleContextCandidate,
    handlePresetChange,
    copyContextBundle,
    copyCombinedPrompt,
    handleLimitChange,
  };
}
