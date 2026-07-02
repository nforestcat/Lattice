import { useRef } from "react";
import { vaultApi } from "../../api";
import { isDesktopRuntime, pickVaultFolder } from "../../api/dialog";
import type { ContextBundle, ContextBundleCandidate, LlmConfig, NoteDocument, Snapshot, VaultConfig, VaultSnapshot } from "../../api/types";
import type { GitFileChange, GitStatus } from "../../api/gitTypes";
import { embeddingModelId, parseEmbeddingsCache, type VectorCache } from "../../api/embeddings";
import type { MetadataSuggestions } from "./useLlm";
import type { GraphData, NoteContext, NoteMeta } from "../../core/types";
import {
  PRESETS as SHARED_PRESETS,
  DEFAULT_LLM_CONFIG,
  normalizePreset,
  normalizeBundleMode,
  normalizeVaultConfig as normalizeVaultConfigShared,
  sanitizeVaultConfig,
  type PresetType,
} from "./contextShared";
import { getStartupVaultPath, rememberVaultPath } from "../vaultStartup";
import { loadNoteContext, loadVaultOverview } from "../contextRefresh";
import { apiKeysCache, hasTauriInternals, hydrateLlmConfigSecrets, saveStoredLlmApiKey } from "../llmSecrets";
import type { InboxCaptureBlock } from "../../core/capture";

type ViewMode = "split" | "edit" | "preview" | "graph" | "distill";
type BundleMode = "short" | "standard" | "full";

type LoadedContext = Awaited<ReturnType<typeof loadNoteContext>>;

type InitialOpenVaultNote = {
  readonly path: string;
  readonly config: VaultConfig;
  readonly notes: NoteMeta[];
  readonly llmConfig: LlmConfig;
  readonly isCurrent: () => boolean;
};

// ponytail: wide single-caller param object is the accepted coupling ceiling.
// Zero-coupling needs restructuring 5 hooks' state ownership — out of scope.
export interface UseVaultSessionParams {
  // useVault
  vault: VaultSnapshot | null;
  setVault: (v: VaultSnapshot | null) => void;
  activePath: string | null;
  setActivePath: (p: string | null) => void;
  document: NoteDocument | null;
  setDocument: (d: NoteDocument | null) => void;
  draft: string;
  setDraft: (d: string) => void;
  setViewMode: (m: ViewMode) => void;
  setStatus: (s: string) => void;
  vaultConfig: VaultConfig;
  setVaultConfig: (c: VaultConfig) => void;
  vaultConfigRef: React.MutableRefObject<VaultConfig>;
  updateVaultConfig: (updates: Partial<VaultConfig>) => Promise<void>;
  setContext: (c: NoteContext | null) => void;
  setSnapshots: (s: Snapshot[]) => void;
  runHealthAudit: () => void;

  // useContextBundle
  setContextBundle: (b: ContextBundle | null) => void;
  setContextCandidates: (c: ContextBundleCandidate[]) => void;
  setSelectedContextPaths: (p: Set<string>) => void;
  setBundlePreset: (p: PresetType) => void;
  setBundlePurpose: (p: string) => void;
  setBundleMode: (m: BundleMode) => void;
  setContextLimit: (l: number) => void;
  PRESETS: typeof SHARED_PRESETS;

  // useLlm
  llmConfig: LlmConfig;
  setLlmConfig: (c: LlmConfig) => void;
  setMetadataSuggestions: (s: MetadataSuggestions | null) => void;

  // useEmbeddings
  setEmbeddingsCache: (value: VectorCache | ((prev: VectorCache) => VectorCache)) => void;

  // useSearch
  setResults: (notes: NoteMeta[]) => void;

  // useGit
  setGitStatus: (s: GitStatus | null) => void;
  setGitChanges: (c: GitFileChange[]) => void;
  setSelectedGitFile: (f: string | null) => void;
  setActiveDiff: (d: string | null) => void;
  setCommitMessage: (m: string) => void;
  setGitOutputLog: (l: string | null) => void;

  // useLinkSuggestions
  updateLinkSuggestions: (content: string, notes: NoteMeta[]) => void;
  updateSemanticRecommendations: (path: string, config: LlmConfig, notes: NoteMeta[]) => void;
  refreshBacklinkSuggestions: (path: string) => void;

  // useInbox
  setInboxCaptures: (c: InboxCaptureBlock[]) => void;

  // usePromptHistory
  pruneExpiredPromptRuns: (policy: string, config: VaultConfig, force: boolean) => void;

  // useUnresolvedLinks
  setActiveUnresolvedTarget: (t: string | null) => void;

  // App local state
  setGraph: (g: GraphData | null) => void;
  setIsCustomLimit: (b: boolean) => void;
  setPromptInstruction: (s: string) => void;
  setArchiveStatus: (s: { fileCount: number; totalBytes: number } | null) => void;
}

function isInboxPath(path: string): boolean {
  return /^Inbox\/.+\.md$/i.test(path);
}

export function useVaultSession(params: UseVaultSessionParams) {
  const openVaultGeneration = useRef(0);
  const {
    vault, setVault,
    activePath, setActivePath,
    document, setDocument,
    draft, setDraft,
    setViewMode, setStatus,
    vaultConfig, setVaultConfig, vaultConfigRef, updateVaultConfig,
    setContext, setSnapshots, runHealthAudit,
    setContextBundle, setContextCandidates, setSelectedContextPaths,
    setBundlePreset, setBundlePurpose, setBundleMode, setContextLimit, PRESETS,
    llmConfig, setLlmConfig, setMetadataSuggestions,
    setEmbeddingsCache,
    setResults,
    setGitStatus, setGitChanges, setSelectedGitFile, setActiveDiff, setCommitMessage, setGitOutputLog,
    updateLinkSuggestions, updateSemanticRecommendations, refreshBacklinkSuggestions,
    setInboxCaptures,
    pruneExpiredPromptRuns,
    setActiveUnresolvedTarget,
    setGraph, setIsCustomLimit, setPromptInstruction, setArchiveStatus,
  } = params;

  function clearActiveNoteState() {
    setActivePath(null);
    setDocument(null);
    setDraft("");
    setContext(null);
    setContextCandidates([]);
    setSelectedContextPaths(new Set());
    setInboxCaptures([]);
  }

  function applyLoadedContext(path: string, loaded: LoadedContext, configToUse: VaultConfig) {
    setMetadataSuggestions(null);
    setContextBundle(null);
    setContext(loaded.context);
    setSnapshots(loaded.snapshots);
    setContextCandidates(loaded.candidates);

    const saved = configToUse.selectedPaths?.[path];
    if (saved && Array.isArray(saved)) {
      setSelectedContextPaths(new Set(saved));
    } else {
      setSelectedContextPaths(new Set(loaded.candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.path)));
    }

    const savedPrompt = configToUse.promptInstructions?.[path] || "";
    setPromptInstruction(savedPrompt);
    setInboxCaptures(loaded.inboxCaptures);
  }

  function applyNoteSuggestions(path: string, note: NoteDocument, notesForSuggestions: NoteMeta[], configToUse: LlmConfig) {
    updateLinkSuggestions(note.content, notesForSuggestions);
    void updateSemanticRecommendations(path, configToUse, notesForSuggestions);
  }

  function applyVaultOverview(nextGraph: GraphData, nextGitStatus: GitStatus) {
    setGraph(nextGraph);
    setGitStatus(nextGitStatus);
  }

  async function refreshArchiveStatus(shouldApply: () => boolean = () => true) {
    try {
      const status = await vaultApi.getArchiveStatus();
      if (!shouldApply()) {
        return;
      }
      setArchiveStatus(status);
    } catch (e) {
      if (shouldApply()) {
        console.error("Failed to load archive status", e);
      }
    }
  }

  async function refreshVaultOverview(): Promise<void> {
    const { graph: nextGraph, gitStatus: nextGitStatus } = await loadVaultOverview(vaultApi);
    applyVaultOverview(nextGraph, nextGitStatus);
  }

  async function refreshContext(
    path: string,
    currentConfig?: VaultConfig,
    currentNotes?: NoteMeta[],
    currentLlmConfig?: LlmConfig,
    currentDocument?: NoteDocument,
  ) {
    const configToUse = currentConfig ?? vaultConfigRef.current;
    const loaded = await loadNoteContext(vaultApi, path, isInboxPath(path));
    applyLoadedContext(path, loaded, configToUse);

    try {
      const note = currentDocument ?? await vaultApi.readNote(path);
      const notesForSuggestions = currentNotes ?? vault?.notes ?? [];
      applyNoteSuggestions(path, note, notesForSuggestions, currentLlmConfig ?? llmConfig);
    } catch (e) {
      console.error("Failed to read note for suggestions/semantics", e);
    }
    void refreshBacklinkSuggestions(path);
  }

  async function refreshContextAfterMutation(path: string): Promise<void> {
    await Promise.all([refreshContext(path), refreshVaultOverview()]);
  }

  async function selectNote(path: string, currentConfig?: VaultConfig, currentNotes?: NoteMeta[], currentLlmConfig?: LlmConfig, preserveViewMode = false) {
    setActiveUnresolvedTarget(null);
    const note = await vaultApi.readNote(path);
    setActivePath(path);
    setDocument(note);
    setDraft(note.content);
    if (!preserveViewMode) {
      setViewMode("split");
    }
    await refreshContext(path, currentConfig, currentNotes, currentLlmConfig, note);
  }

  async function selectNoteAfterMutation(path: string): Promise<void> {
    await Promise.all([selectNote(path), refreshVaultOverview()]);
  }

  async function selectInitialOpenVaultNote(input: InitialOpenVaultNote): Promise<void> {
    const [note, loaded] = await Promise.all([
      vaultApi.readNote(input.path),
      loadNoteContext(vaultApi, input.path, isInboxPath(input.path)),
    ]);
    if (!input.isCurrent()) {
      return;
    }

    setActivePath(input.path);
    setDocument(note);
    setDraft(note.content);
    setViewMode("split");
    applyLoadedContext(input.path, loaded, input.config);
    applyNoteSuggestions(input.path, note, input.notes, input.llmConfig);
    void refreshBacklinkSuggestions(input.path);
  }

  async function openVault(path: string) {
    const generation = openVaultGeneration.current + 1;
    openVaultGeneration.current = generation;
    const isCurrent = () => generation === openVaultGeneration.current;

    const nextVault = await vaultApi.openVault(path);
    if (!isCurrent()) {
      return;
    }
    setVault(nextVault);
    setResults(nextVault.notes);
    clearActiveNoteState();
    setStatus(`Opened ${nextVault.rootPath}`);

    let loadedConfig: VaultConfig = {};
    let runtimeLlmConfig: LlmConfig = DEFAULT_LLM_CONFIG;
    try {
      const rawConfig = await vaultApi.getVaultConfig();
      if (!isCurrent()) {
        return;
      }
      loadedConfig = normalizeVaultConfigShared(rawConfig);
      const rawLlmConfig = rawConfig?.llmConfig;
      if (rawLlmConfig && typeof rawLlmConfig === "object" && typeof rawLlmConfig.apiKey === "string" && rawLlmConfig.apiKey.trim()) {
        const provider = loadedConfig.llmConfig?.provider || DEFAULT_LLM_CONFIG.provider;
        saveStoredLlmApiKey(provider, rawLlmConfig.apiKey);
        await vaultApi.saveVaultConfig(sanitizeVaultConfig(loadedConfig));
      }
      vaultConfigRef.current = loadedConfig;
      setVaultConfig(loadedConfig);

      const limit = loadedConfig.contextLimit ?? 8000;
      setContextLimit(limit);
      setIsCustomLimit(limit !== 8000 && limit !== 32000 && limit !== 128000 && limit !== 200000);

      const preset = normalizePreset(loadedConfig.bundlePreset);
      setBundlePreset(preset);

      const purpose = typeof loadedConfig.bundlePurpose === "string" ? loadedConfig.bundlePurpose : PRESETS[preset].purpose;
      setBundlePurpose(purpose);

      const mode = normalizeBundleMode(loadedConfig.bundleMode, PRESETS[preset].mode);
      setBundleMode(mode);

      const llmCfg = hydrateLlmConfigSecrets(loadedConfig.llmConfig || DEFAULT_LLM_CONFIG);
      runtimeLlmConfig = llmCfg;
      setLlmConfig(llmCfg);

      const rawCache = await vaultApi.loadEmbeddingsCache();
      if (!isCurrent()) {
        return;
      }
      setEmbeddingsCache(parseEmbeddingsCache(rawCache, embeddingModelId(llmCfg)));

      if (loadedConfig.archiveRetentionPolicy && loadedConfig.archiveRetentionPolicy !== "none") {
        void pruneExpiredPromptRuns(loadedConfig.archiveRetentionPolicy, loadedConfig, false);
      }
    } catch (e) {
      console.error("Failed to load vault config", e);
    }
    if (!isCurrent()) {
      return;
    }

    if (nextVault.obsidianSettings?.detected) {
      setStatus("Imported Obsidian settings");
    }
    const firstNote = nextVault.notes[0];
    const noteSelection = firstNote
      ? selectInitialOpenVaultNote({
        path: firstNote.path,
        config: loadedConfig,
        notes: nextVault.notes,
        llmConfig: runtimeLlmConfig,
        isCurrent,
      })
      : Promise.resolve();
    const [{ graph: nextGraph, gitStatus: nextGitStatus }] = await Promise.all([
      loadVaultOverview(vaultApi),
      noteSelection,
    ]);
    if (!isCurrent()) {
      return;
    }
    applyVaultOverview(nextGraph, nextGitStatus);
    setGitChanges([]);
    setSelectedGitFile(null);
    setActiveDiff(null);
    setCommitMessage("");
    setGitOutputLog(null);
    void refreshArchiveStatus(isCurrent);
    if (isCurrent()) {
      void runHealthAudit();
    }
  }

  async function chooseVaultFolder() {
    const selectedPath = await pickVaultFolder();
    if (!selectedPath) {
      setStatus("Vault selection cancelled");
      return;
    }

    rememberVaultPath(window.localStorage, selectedPath);
    await openVault(selectedPath);
  }

  async function refreshVault(selectedPath: string | null) {
    const nextVault = await vaultApi.openVault(vault?.rootPath ?? "Demo Vault");
    setVault(nextVault);
    setResults(nextVault.notes);
    const noteSelection = selectedPath
      ? selectNote(selectedPath, undefined, nextVault.notes, undefined, true)
      : Promise.resolve();
    if (!selectedPath) {
      clearActiveNoteState();
    }
    await Promise.all([noteSelection, refreshVaultOverview()]);
    void refreshArchiveStatus();
    void runHealthAudit();
  }

  async function saveActiveNote() {
    if (!document) {
      return;
    }

    const result = await vaultApi.saveNote(document.path, draft, document.revision);
    if (result.conflict) {
      setStatus("Conflict detected. Snapshot created before overwriting.");
      await refreshContextAfterMutation(document.path);
      return;
    }

    setDocument({ ...document, content: draft, revision: result.revision });
    setStatus(result.gitCommit ? `Saved and committed ${result.gitCommit}` : "Saved");
    await refreshContextAfterMutation(document.path);
    void runHealthAudit();
  }

  return {
    openVault,
    chooseVaultFolder,
    refreshVault,
    selectNote,
    selectNoteAfterMutation,
    refreshVaultOverview,
    refreshContext,
    refreshContextAfterMutation,
    saveActiveNote,
    clearActiveNoteState,
    refreshArchiveStatus,
  };
}
