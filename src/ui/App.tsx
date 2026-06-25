import { markdown } from "@codemirror/lang-markdown";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { vaultApi } from "../api";
import { askConfirm, askInput, isDesktopRuntime } from "../api/dialog";
import type { ContextBundle, ContextBundleCandidate, FileTreeNode, NoteDocument, VaultSnapshot, VaultConfig, PromptRun, PromptTemplate, ProposedEdit, LlmConfig, LlmProvider, BacklinkSuggestion, NoteTemplate, StubDraftReview, UnresolvedLinkGroup, UnresolvedLinkSource, SourceMutationResult } from "../api/types";
import { canUseEmbeddings, getEmbedding } from "../api/embeddings";
import type { GraphData, NoteMeta } from "../core/types";
import { renderMarkdownPreview } from "./markdownPreview";
import { getStartupVaultPath } from "./vaultStartup";
import { computeHash, apiKeysCache, hasTauriInternals, readStoredLlmApiKey, saveStoredLlmApiKey } from "./llmSecrets";
import { DEFAULT_NOTE_TEMPLATES, BUILTIN_TEMPLATES } from "./noteTemplates";
import { GraphView } from "./components/GraphView";
import { DistillWorkspace } from "./components/DistillWorkspace";
import { Sidebar } from "./components/Sidebar";
import { EditorToolbar } from "./components/EditorToolbar";
import { RightSidebar } from "./components/RightSidebar";
import { IngestPanel } from "./components/IngestPanel";
import { ConflictResolver } from "./components/ConflictResolver";
import { useModelDownload } from "./hooks/useModelDownload";
import { ModelDownloadContext } from "./contexts/ModelDownloadContext";
import { useGit } from "./hooks/useGit";
import { useEmbeddings } from "./hooks/useEmbeddings";
import { useSearch } from "./hooks/useSearch";
import { useVault } from "./hooks/useVault";
import { useContextBundle } from "./hooks/useContextBundle";
import { useLlm } from "./hooks/useLlm";
import { usePromptHistory } from "./hooks/usePromptHistory";
import { useStubDrafting } from "./hooks/useStubDrafting";
import { useUnresolvedLinks } from "./hooks/useUnresolvedLinks";
import { useVaultSession } from "./hooks/useVaultSession";
import { useLinkSuggestions } from "./hooks/useLinkSuggestions";
import { useInbox } from "./hooks/useInbox";
import { useReviewQueue } from "./hooks/useReviewQueue";
import { useIngestQueue } from "./hooks/useIngestQueue";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { applyProposedEditToVault } from "./proposedEditApply";
import { findAmbiguousUpdateAnchor } from "./proposedEditGuards";
import {
  PRESETS as SHARED_PRESETS,
  type PresetType as SharedPresetType,
  VAULT_CONFIG_VERSION,
  DEFAULT_LLM_CONFIG,
  normalizePreset,
  normalizeBundleMode,
  normalizeVaultConfig as normalizeVaultConfigShared,
  presetForSettings,
  buildCombinedPrompt,
  simplePromptHash,
  redactLlmConfig,
  sanitizeVaultConfig,
  errorMessage,
} from "./hooks/contextShared";

export type PresetType = SharedPresetType;
export const PRESETS = SHARED_PRESETS;
export { normalizeVaultConfigShared as normalizeVaultConfig };

type ViewMode = "split" | "edit" | "preview" | "graph" | "distill";

function sourceMutationResult(paths: readonly string[] | false): SourceMutationResult {
  return {
    changedPaths: paths === false ? [] : paths,
    warnings: [],
  };
}


async function hashPromptContent(content: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    try {
      const bytes = new TextEncoder().encode(content);
      const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(hashBuffer)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      return simplePromptHash(content);
    }
  }
  return simplePromptHash(content);
}

export function App() {
  const vaultHook = useVault({
    setResults: (notes) => setResults(notes),
    selectNote: (path) => selectNoteAfterMutation(path),
    refreshVault: (path) => refreshVault(path),
    clearActiveNoteState: () => clearActiveNoteState(),
  });
  const {
    vault, setVault,
    activePath, setActivePath,
    document, setDocument,
    draft, setDraft,
    viewMode, setViewMode,
    status, setStatus,
    vaultConfig, setVaultConfig,
    vaultConfigRef,
    updateVaultConfig,
    createNoteInCurrentFolder,
    createFolderInCurrentFolder,
    renameTreeEntry,
    deleteTreeEntry,
    context, setContext,
    snapshots, setSnapshots,
    healthReports,
    isScanningHealth,
    globalHealthScore,
    runHealthAudit,
  } = vaultHook;

  const [graph, setGraph] = useState<GraphData | null>(null);
  const [sortBy, setSortBy] = useState<"score" | "title" | "reason">("score");
  const [filterBy, setFilterBy] = useState<string>("all");
  const [isCustomLimit, setIsCustomLimit] = useState<boolean>(false);
  const [promptInstruction, setPromptInstruction] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  const [archiveStatus, setArchiveStatus] = useState<{ fileCount: number; totalBytes: number } | null>(null);
  const [currentPromptHash, setCurrentPromptHash] = useState<string | null>(null);
  const [showIngestPanel, setShowIngestPanel] = useState(false);
  const [showConflictResolver, setShowConflictResolver] = useState(false);
  const [distillTab, setDistillTab] = useState<"paste" | "chat" | "auditor" | "git" | "review">("paste");
  const [rightSidebarTab, setRightSidebarTab] = useState<"context" | "suggestions" | "index">("context");
  const [embeddingBannerDismissed, setEmbeddingBannerDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("lattice.onboarding.embeddingBannerDismissed") === "true";
    } catch {
      return false;
    }
  });

  function dismissEmbeddingBanner() {
    setEmbeddingBannerDismissed(true);
    try { localStorage.setItem("lattice.onboarding.embeddingBannerDismissed", "true"); } catch { /* ignore */ }
  }
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const previewScrollRef = useRef<HTMLElement | null>(null);
  const isSyncingScroll = useRef(false);
  const pendingPreviewLineRef = useRef<number | null>(null);
  const [includeContext, setIncludeContext] = useState(true);

  const allTags = useMemo(() => Array.from(new Set(vault?.notes.flatMap((note) => note.tags) ?? [])).sort(), [vault]);

  const bundle = useContextBundle({
    activePath,
    vaultConfig,
    vaultConfigRef,
    promptInstruction,
    updateVaultConfig,
    setStatus,
    onArchiveChanged: () => { void refreshArchiveStatus(); },
  });
  const {
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
  } = bundle;

  const llm = useLlm({
    activePath,
    vault,
    setVault,
    document,
    draft,
    setDraft,
    contextBundle,
    promptInstruction,
    includeContext,
    allTags,
    vaultConfig,
    defaultNoteTemplates: DEFAULT_NOTE_TEMPLATES,
    setStatus,
    selectNote: (path) => selectNoteAfterMutation(path),
    runHealthAudit: () => runHealthAudit(),
  });
  const {
    llmConfig, setLlmConfig,
    showLlmSettings, setShowLlmSettings,
    isLlmGenerating, setIsLlmGenerating,
    chatMessages, setChatMessages,
    chatInput, setChatInput,
    distillInputText, setDistillInputText,
    proposedEdits, setProposedEdits,
    metadataSuggestions, setMetadataSuggestions,
    selectedSuggestedTags,
    selectedSuggestedProperties,
    isGeneratingMetadata,
    isAutofillingTemplate,
    handleSendChatMessage,
    clearChatHistory,
    generateMetadataSuggestions,
    handleToggleSuggestedTag,
    handleToggleSuggestedProperty,
    applyMetadataSuggestions,
    autofillActiveNoteWithTemplate,
    generateRepairForIssue,
    generateAllRepairsForNote,
    generatingRepairFor,
  } = llm;

  const embeddings = useEmbeddings(llmConfig, vault);
  const {
    embeddingsCache, setEmbeddingsCache,
    embeddingStatus,
    isSearchingSemantic,
    semanticSearchError,
    updateSemanticRecommendations: updateSemanticRecommendationsBase,
  } = embeddings;

  const search = useSearch(vault, embeddings);
  const {
    query, setQuery,
    tagFilter, setTagFilter,
    propertyFilter, setPropertyFilter,
    results, setResults,
    searchMode, setSearchMode,
    runSearch,
  } = search;

  const unresolved = useUnresolvedLinks();
  const {
    unresolvedLinks,
    isScanningUnresolved,
    selectedUnresolvedTargets,
    activeUnresolvedTarget,
    setActiveUnresolvedTarget,
  } = unresolved;

  const stub = useStubDrafting({
    llmConfig,
    vault,
    activePath,
    setStatus,
    refreshVault: (path) => refreshVault(path),
    unresolved,
  });
  const {
    bulkDrafts, setBulkDrafts,
    isBulkProcessing,
    runUnresolvedLinksScan,
    draftStubNote,
    runBulkDrafting,
    applyStubDraft,
    handleSelectAllToggle,
  } = stub;

  const git = useGit({
    refreshVault: (path) => refreshVault(path),
    setActivePath,
    setDocument,
    setDraft,
    setViewMode,
    setDistillTab,
    activePath,
    runUnresolvedLinksScan,
    draftStubNote,
    unresolved,
  });
  const {
    gitStatus, setGitStatus,
    gitChanges, setGitChanges,
    selectedGitFile, setSelectedGitFile,
    selectedGitFileStaged, setSelectedGitFileStaged,
    activeDiff, setActiveDiff,
    commitMessage, setCommitMessage,
    isGitLoading,
    gitOutputLog, setGitOutputLog,
    auditorSubTab, setAuditorSubTab,
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
    canDropStash,
    handlePullAnyway,
    cancelPendingPull,
    handleStashAndPull,
    handleDropStash,
    forceFreshConflictResolver,
    setForceFreshConflictResolver,
    openUnresolvedTarget,
    selectUnresolvedTarget,
    draftUnresolvedTarget,
    toggleAutoGit,
  } = git;

  const {
    linkSuggestions, setLinkSuggestions,
    backlinkSuggestions,
    isLoadingBacklinkSuggestions,
    updateLinkSuggestions,
    applyWikiLinkSuggestion,
    insertWikiLinkAtCursor,
    refreshBacklinkSuggestions,
    applyBacklinkSuggestion: applyBacklinkSuggestionBase,
  } = useLinkSuggestions({ activePath, draft, setDraft, vault, setVault, setStatus, editorRef });

  const {
    inboxCaptures, setInboxCaptures,
    captureDraft, setCaptureDraft,
    triageCaptureToAppend, setTriageCaptureToAppend,
    noteSearchQuery, setNoteSearchQuery,
    captureToInbox,
    promoteInboxCapture,
    markInboxCaptureProcessed,
    handleAppendCapture,
  } = useInbox({
    vault,
    setVault,
    activePath,
    setResults,
    setStatus,
    selectNote: (path) => selectNoteAfterMutation(path),
  });

  const gitStagedPaths = useMemo(
    () => new Set(gitChanges.filter(c => c.staged).map(c => c.path)),
    [gitChanges]
  );

  const ingestQueue = useIngestQueue({
    onIngested: (path) => refreshVault(path),
    setVault: (v) => setVault((prev) => prev ? { ...prev, ...v } : prev),
  });

  const reviewQueue = useReviewQueue({
    inboxCaptures,
    bulkDrafts,
    proposedEdits,
    healthReports,
    backlinkSuggestions,
    ingestItems: ingestQueue.ingestItems,
    gitStagedPaths,
    onApplyInboxCapture: async (id) =>
      sourceMutationResult(await markInboxCaptureProcessed(id)),
    onApplyProposedEdit: async (id) =>
      sourceMutationResult(await applyProposedEditFromQueue(id)),
    onApplyBacklinkSuggestion: async (id) => {
      const suggestion = backlinkSuggestions.find((item) => item.id === id);
      if (!suggestion) {
        return { changedPaths: [], warnings: [] };
      }
      return applyBacklinkSuggestion(suggestion);
    },
    onApplyIngestCapture: (id) => ingestQueue.applyIngestItem(id),
    onUpdateIngestCapture: (id, patch) => { ingestQueue.updateIngestItem(id, patch); },
  });

  const modelDownload = useModelDownload();

  // Show banner when: provider unset AND model not downloaded AND not dismissed
  const showEmbeddingBanner = !embeddingBannerDismissed
    && !llmConfig?.embeddingProvider
    && !modelDownload.downloaded;

  const promptHistory = usePromptHistory({
    vaultConfig,
    vaultConfigRef,
    setVaultConfig,
    updateVaultConfig,
    setStatus,
    selectNote: (path, currentConfig) => selectNote(path, currentConfig),
    contextBundle,
    setContextBundle,
    setPrevContextBundle,
    setBundlePreset,
    setBundlePurpose,
    setBundleMode,
    promptInstruction,
    refreshArchiveStatus: () => { void refreshArchiveStatus(); },
  });
  const {
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
  } = promptHistory;

  const updateSemanticRecommendations = (path: string, config: LlmConfig, notes: NoteMeta[]) =>
    updateSemanticRecommendationsBase(path, config, notes, setContextCandidates);

  const session = useVaultSession({
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
    updateLinkSuggestions, updateSemanticRecommendations,
    refreshBacklinkSuggestions,
    setInboxCaptures,
    pruneExpiredPromptRuns,
    setActiveUnresolvedTarget,
    setGraph, setIsCustomLimit, setPromptInstruction, setArchiveStatus,
  });
  const {
    openVault, chooseVaultFolder,
    refreshVault, selectNote, selectNoteAfterMutation,
    refreshVaultOverview, refreshContext, refreshContextAfterMutation,
    saveActiveNote, clearActiveNoteState, refreshArchiveStatus,
  } = session;

  const applyBacklinkSuggestion = (suggestion: BacklinkSuggestion) =>
    applyBacklinkSuggestionBase(suggestion, refreshContextAfterMutation, runHealthAudit);

  const handlePromptInstructionChange = (val: string) => {
    setPromptInstruction(val);
    if (activePath) {
      const currentPrompts = vaultConfigRef.current.promptInstructions ?? {};
      const nextPrompts = {
        ...currentPrompts,
        [activePath]: val
      };
      void updateVaultConfig({ promptInstructions: nextPrompts });
    }
  };

  useEffect(() => {
    async function init() {
      if (hasTauriInternals()) {
        const providers: LlmProvider[] = ["openai", "anthropic", "gemini", "ollama", "lm-studio", "custom"];
        for (const provider of providers) {
          try {
            const key = await vaultApi.getApiKey(provider);
            if (key) {
              apiKeysCache[provider] = key;
            }
          } catch (e) {
            console.error(`Failed to load key for ${provider}`, e);
          }
        }
      }
      void openVault(getStartupVaultPath(window.localStorage, isDesktopRuntime()));
    }
    void init();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!contextBundle) {
      setCurrentPromptHash(null);
      return;
    }

    const combined = buildCombinedPrompt(promptInstruction, contextBundle.markdown);
    void hashPromptContent(combined).then((hash) => {
      if (!cancelled) {
        setCurrentPromptHash(hash);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [contextBundle, promptInstruction]);

  useEffect(() => {
    if (vault?.notes) {
      updateLinkSuggestions(draft, vault.notes);
    }
  }, [draft, vault?.notes, updateLinkSuggestions]);

  // Real-time Background Embedding Synchronization
  useEffect(() => {
    const config = llmConfig;
    if (!canUseEmbeddings(config)) {
      return;
    }
    if (!activePath || !draft) {
      return;
    }
    if (!document || document.path !== activePath || draft === document.content) {
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const hash = await computeHash(draft);
        
        let alreadyExists = false;
        setEmbeddingsCache(prev => {
          const cached = prev[activePath];
          if (cached && cached.contentHash === hash) {
            alreadyExists = true;
          }
          return prev;
        });

        if (alreadyExists) {
          return;
        }

        const vector = await getEmbedding(config, draft);
        if (vector && vector.length > 0) {
          setEmbeddingsCache(prev => {
            const nextCache = {
              ...prev,
              [activePath]: {
                contentHash: hash,
                vector
              }
            };
            void vaultApi.saveEmbeddingsCache(JSON.stringify(nextCache));
            return nextCache;
          });

          // Sync recommendation list in the background
          void updateSemanticRecommendations(activePath, config, vault?.notes || []);
        }
      } catch (err) {
        console.error("Background embedding sync error:", err);
      }
    }, 3000);

    return () => clearTimeout(timer);
  }, [draft, activePath, document?.path, document?.content, llmConfig, vault?.notes]);

  async function restoreSnapshot(snapshotId: string) {
    await vaultApi.restoreSnapshot(snapshotId);
    if (activePath) {
      await selectNoteAfterMutation(activePath);
      setStatus("Snapshot restored");
    }
  }

  async function createGraphLink(sourcePath: string, targetPath: string) {
    const result = await vaultApi.createGraphLink(sourcePath, targetPath);
    setGraph(result.graph);
    if (sourcePath === activePath) {
      setDocument(result.note);
      setDraft(result.note.content);
    }
    setStatus("Graph link added to ## Links");
    await Promise.all([
      refreshContext(sourcePath),
      vaultApi.getGitStatus().then(setGitStatus),
    ]);
    void runHealthAudit();
  }

  async function deleteGraphLink(sourcePath: string, targetPath: string) {
    if (!(await askConfirm(`Remove managed graph link to "${targetPath}"?`, "Delete Link"))) {
      return;
    }

    const result = await vaultApi.deleteManagedGraphLink(sourcePath, targetPath);
    setGraph(result.graph);
    if (sourcePath === activePath) {
      setDocument(result.note);
      setDraft(result.note.content);
    }
    setStatus("Managed graph link removed");
    await Promise.all([
      refreshContext(sourcePath),
      vaultApi.getGitStatus().then(setGitStatus),
    ]);
    void runHealthAudit();
  }

  async function applyProposedEditFromQueue(id: string): Promise<readonly string[] | false> {
    return applySelectedProposedEdits(new Set([id]));
  }

  async function applyCheckedEdits() {
    await applySelectedProposedEdits(null);
  }

  async function applySelectedProposedEdits(selectedIds: ReadonlySet<string> | null): Promise<readonly string[] | false> {
    const shouldApply = (edit: ProposedEdit) => !edit.applied && (selectedIds ? selectedIds.has(edit.id) : edit.checked);
    const checkedEdits = proposedEdits.filter(shouldApply);
    if (checkedEdits.length === 0) return false;

    const destructiveCount = checkedEdits.filter((edit) => edit.type === "delete" || edit.type === "merge").length;
    const message = destructiveCount > 0
      ? `Apply ${checkedEdits.length} proposed wiki edit(s), including ${destructiveCount} destructive edit(s)?`
      : `Apply ${checkedEdits.length} proposed wiki edit(s)?`;
    if (!(await askConfirm(message, "Apply Proposed Wiki Edits"))) {
      return false;
    }

    try {
      const ambiguousAnchor = await findAmbiguousUpdateAnchor(checkedEdits, (path) => vaultApi.readNote(path));
      if (ambiguousAnchor) {
        setStatus(`Warning: anchor for "${ambiguousAnchor.path}" appears multiple times. Refine the proposed edit before applying.`);
        return false;
      }
    } catch {
      // Ignore pre-check errors; apply will surface them.
    }

    let appliedCount = 0;
    const mutatedPaths = new Set<string>();
    const nextEdits = [...proposedEdits];

    for (let i = 0; i < nextEdits.length; i++) {
      const edit = nextEdits[i];
      if (!shouldApply(edit)) {
        continue;
      }

      try {
        nextEdits[i] = await applyProposedEditToVault(edit);
        mutatedPaths.add(edit.path);
        if (edit.type === "merge" && edit.newPath) mutatedPaths.add(edit.newPath);
        appliedCount++;
      } catch (err) {
        console.error("Failed to apply proposed edit", edit, err);
        setStatus(`Error applying edit to ${edit.path}: ${errorMessage(err)}`);
        setProposedEdits(nextEdits);
        return false;
      }
    }

    setProposedEdits(nextEdits);
    setStatus(`Successfully applied ${appliedCount} wiki edit(s).`);
    await refreshVault(activePath);
    return [...mutatedPaths];
  }

  function compileTemplate(templateText: string): string {
    const activeNoteTitle = activePath 
      ? (vault?.notes.find(n => n.path === activePath)?.title || activePath.split('/').pop()?.replace(/\.md$/, "") || "")
      : "";
      
    const selectedNoteTitles = Array.from(selectedContextPaths).map(path => {
      return vault?.notes.find(n => n.path === path)?.title || path.split('/').pop()?.replace(/\.md$/, "") || path;
    });

    const vaultName = vault?.rootPath 
      ? (vault.rootPath.split(/[/\\]/).pop() || vault.rootPath)
      : "Vault";

    const currentDate = new Date().toLocaleDateString();

    return templateText
      .replace(/{active_note}/g, activeNoteTitle)
      .replace(/{selected_notes}/g, selectedNoteTitles.map(t => `[[${t}]]`).join(", "))
      .replace(/{date}/g, currentDate)
      .replace(/{vault_name}/g, vaultName);
  }

  async function saveAsTemplate() {
    if (!promptInstruction.trim()) {
      setStatus("No instruction text to save as template");
      return;
    }
    const name = await askInput("Enter a name for this prompt template:", { title: "Save Template" });
    if (!name || !name.trim()) {
      return;
    }
    try {
      const newTemplate: PromptTemplate = {
        id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
        name: name.trim(),
        template: promptInstruction.trim(),
        isSystem: false
      };
      const currentTemplates = vaultConfigRef.current.promptTemplates ?? [];
      const nextTemplates = [...currentTemplates, newTemplate];
      await updateVaultConfig({ promptTemplates: nextTemplates });
      setStatus(`Saved prompt template "${name.trim()}"`);
    } catch (err) {
      setStatus(errorMessage(err));
    }
  }

  async function deleteTemplate(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!(await askConfirm("Are you sure you want to delete this custom template?", "Delete Template"))) {
      return;
    }
    try {
      const currentTemplates = vaultConfigRef.current.promptTemplates ?? [];
      const nextTemplates = currentTemplates.filter(t => t.id !== id);
      await updateVaultConfig({ promptTemplates: nextTemplates });
      setStatus("Deleted custom template");
    } catch (err) {
      setStatus(errorMessage(err));
    }
  }

  const editorShortcutExtension = useKeyboardShortcuts({
    activePath,
    notes: vault?.notes ?? [],
    saveActiveNote,
    selectNote: (path) => selectNote(path, undefined, undefined, undefined, true),
    setViewMode,
  });

  const html = useMemo(() => ({ __html: renderMarkdownPreview(draft) }), [draft]);
  const themeStyles = useMemo<React.CSSProperties>(() => {
    const color = vault?.obsidianSettings?.accentColor;
    if (color) {
      return {
        "--accent-color": color,
        "--link-color": color
      } as React.CSSProperties;
    }
    return {} as React.CSSProperties;
  }, [vault]);
  const selectedContextCount = contextCandidates.filter((candidate) => selectedContextPaths.has(candidate.path)).length;
  const selectedContextCharacters = contextCandidates
    .filter((candidate) => selectedContextPaths.has(candidate.path))
    .reduce((total, candidate) => total + candidate.characterCount, 0);

  const selectedContextTokens = useMemo(() => {
    const selectedNotes = contextCandidates.filter((candidate) => selectedContextPaths.has(candidate.path));
    return selectedNotes.reduce((total, candidate) => total + candidate.tokenEstimate, 0);
  }, [contextCandidates, selectedContextPaths]);

  const displayedCandidates = useMemo(() => {
    let list = [...contextCandidates];
    if (filterBy === "selected") {
      list = list.filter((c) => selectedContextPaths.has(c.path));
    } else if (filterBy !== "all") {
      list = list.filter((c) => c.reason.toLowerCase() === filterBy);
    }

    list.sort((a, b) => {
      if (sortBy === "score") {
        return b.score - a.score;
      } else if (sortBy === "title") {
        return a.title.localeCompare(b.title);
      } else if (sortBy === "reason") {
        const reasonOrder: Record<string, number> = {
          focus: 0,
          outgoing: 1,
          backlink: 2,
          recommended: 3
        };
        const orderA = reasonOrder[a.reason.toLowerCase()] ?? 99;
        const orderB = reasonOrder[b.reason.toLowerCase()] ?? 99;
        if (orderA !== orderB) {
          return orderA - orderB;
        }
        return b.score - a.score;
      }
      return 0;
    });
    return list;
  }, [contextCandidates, selectedContextPaths, sortBy, filterBy]);

  useEffect(() => {
    if (gitStatus?.hasConflicts) {
      setShowConflictResolver(true);
    }
  }, [gitStatus?.hasConflicts]);

  const isActiveNoteConflicted = useMemo(() => activePath && (
    gitChanges.some(c => c.path === activePath && c.status === "conflict") ||
    (viewMode !== "distill" && viewMode !== "graph" && draft.includes("<<<<<<<") && draft.includes("=======") && draft.includes(">>>>>>>"))
  ), [activePath, gitChanges, viewMode, draft]);

  const focusEditorLine = useCallback((lineNum: number): boolean => {
    const view = editorRef.current?.view;
    if (!view) return false;
    const boundedLine = Math.min(Math.max(lineNum, 1), view.state.doc.lines);
    const line = view.state.doc.line(boundedLine);
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    view.focus();
    return true;
  }, []);

  useEffect(() => {
    if (viewMode !== "edit" || pendingPreviewLineRef.current === null) return;
    let retries = 0;
    let frame: number;
    function tryFocus() {
      const pendingLine = pendingPreviewLineRef.current;
      if (pendingLine !== null && focusEditorLine(pendingLine)) {
        pendingPreviewLineRef.current = null;
        return;
      }
      retries++;
      if (retries < 10 && pendingPreviewLineRef.current !== null) {
        frame = requestAnimationFrame(tryFocus);
      }
    }
    frame = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(frame);
  }, [focusEditorLine, viewMode]);

  useEffect(() => {
    if (viewMode !== "split") return;
    const scrollDOM = editorRef.current?.view?.scrollDOM;
    const preview = previewScrollRef.current;
    if (!scrollDOM || !preview) return;

    const onEditorScroll = () => {
      if (isSyncingScroll.current) return;
      isSyncingScroll.current = true;
      const ratio = scrollDOM.scrollTop / (scrollDOM.scrollHeight - scrollDOM.clientHeight || 1);
      preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
      requestAnimationFrame(() => { isSyncingScroll.current = false; });
    };

    const onPreviewScroll = () => {
      if (isSyncingScroll.current) return;
      isSyncingScroll.current = true;
      const ratio = preview.scrollTop / (preview.scrollHeight - preview.clientHeight || 1);
      scrollDOM.scrollTop = ratio * (scrollDOM.scrollHeight - scrollDOM.clientHeight);
      requestAnimationFrame(() => { isSyncingScroll.current = false; });
    };

    scrollDOM.addEventListener("scroll", onEditorScroll);
    preview.addEventListener("scroll", onPreviewScroll);
    return () => {
      scrollDOM.removeEventListener("scroll", onEditorScroll);
      preview.removeEventListener("scroll", onPreviewScroll);
    };
  }, [viewMode]);

  return (
    <main className="workspace" style={themeStyles}>
      <Sidebar
        vault={vault}
        chooseVaultFolder={chooseVaultFolder}
        query={query}
        tagFilter={tagFilter}
        propertyFilter={propertyFilter}
        allTags={allTags}
        searchMode={searchMode}
        setSearchMode={setSearchMode}
        runSearch={runSearch}
        setQuery={setQuery}
        setTagFilter={setTagFilter}
        setPropertyFilter={setPropertyFilter}
        createNoteInCurrentFolder={createNoteInCurrentFolder}
        createFolderInCurrentFolder={createFolderInCurrentFolder}
        activePath={activePath}
        selectNote={selectNote}
        renameTreeEntry={renameTreeEntry}
        deleteTreeEntry={deleteTreeEntry}
        isSearchingSemantic={isSearchingSemantic}
        semanticSearchError={semanticSearchError}
        results={results}
        globalHealthScore={globalHealthScore}
        isScanningHealth={isScanningHealth}
        onGoToAuditor={() => { setViewMode("distill"); setDistillTab("auditor"); }}
        onOpenIngest={() => setShowIngestPanel(true)}
      />

      <IngestPanel
        open={showIngestPanel}
        onClose={() => setShowIngestPanel(false)}
        llmConfig={llmConfig}
        vaultConfig={vaultConfig}
        enqueueIngest={ingestQueue.enqueueIngest}
        onOpenReviewQueue={() => { setShowIngestPanel(false); setViewMode("distill"); setDistillTab("review"); }}
      />

      <ConflictResolver
        open={showConflictResolver}
        forceFresh={forceFreshConflictResolver}
        onClose={() => { setShowConflictResolver(false); setForceFreshConflictResolver(false); }}
        onResolved={() => {
          setShowConflictResolver(false);
          setForceFreshConflictResolver(false);
          void refreshGitWorkspace();
        }}
      />

      <ModelDownloadContext.Provider value={modelDownload}>
      <section className="editorPane">
        {showEmbeddingBanner && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "8px 14px", background: "#eff6ff", borderBottom: "1px solid #bfdbfe",
            fontSize: "12px", gap: 12,
          }}>
            <span style={{ color: "#1d4ed8" }}>
              ✦ Enable offline semantic search — no API key needed, runs on your device.
            </span>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button
                type="button"
                className="smallButton primary"
                onClick={() => setRightSidebarTab("index")}
                style={{ fontSize: "11px" }}
              >
                Set up
              </button>
              <button
                type="button"
                className="smallButton"
                onClick={dismissEmbeddingBanner}
                style={{ fontSize: "11px" }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        <EditorToolbar
          viewMode={viewMode}
          setViewMode={setViewMode}
          context={context}
          activePath={activePath}
          vaultConfig={vaultConfig}
          DEFAULT_NOTE_TEMPLATES={DEFAULT_NOTE_TEMPLATES}
          isAutofillingTemplate={isAutofillingTemplate}
          autofillActiveNoteWithTemplate={autofillActiveNoteWithTemplate}
          saveActiveNote={saveActiveNote}
        />

        <div className={`editorWorkspace ${viewMode === "split" ? "split" : "single"}`}>
          {(viewMode === "split" || viewMode === "edit") && (
            <section className="editorSurface" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              {isActiveNoteConflicted && (
                <div className="editorConflictBanner">
                  ⚠️ This note has unresolved merge conflicts. Please resolve the conflicts before committing.
                </div>
              )}
              <div style={{ flex: 1, minHeight: 0 }}>
                <CodeMirror
                  ref={editorRef}
                  value={draft}
                  height="100%"
                  extensions={[markdown(), editorShortcutExtension]}
                  theme={vault?.obsidianSettings?.theme === "obsidian" || vault?.obsidianSettings?.theme === "dark" ? "dark" : "light"}
                  basicSetup={{ lineNumbers: true, foldGutter: true }}
                  onChange={setDraft}
                />
              </div>
              {linkSuggestions.length > 0 && (
                <div className="linkSuggestionsPanel">
                  <span className="panelLabel">Link Suggestions:</span>
                  <div className="suggestionBadges">
                    {linkSuggestions.map((s, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className="suggestionBadge"
                        onClick={() => applyWikiLinkSuggestion(s.text)}
                        title={`Convert "${s.text}" to [[${s.text}]]`}
                      >
                        🔌 [[{s.text}]]
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}
          {(viewMode === "split" || viewMode === "preview") && (
            <div className="previewContainer" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
              {viewMode === "preview" && isActiveNoteConflicted && (
                <div className="editorConflictBanner">
                  ⚠️ This note has unresolved merge conflicts. Please resolve the conflicts before committing.
                </div>
              )}
              <article
                ref={previewScrollRef}
                className={`preview previewSurface ${vault?.obsidianSettings?.readableLineLength ? "previewReadable" : ""} ${
                  vault?.obsidianSettings?.theme === "obsidian" || vault?.obsidianSettings?.theme === "dark" ? "theme-dark" : ""
                }`}
                style={{ flex: 1, overflow: 'auto', cursor: 'text' }}
                dangerouslySetInnerHTML={html}
                onClick={(e) => {
                  const target = (e.target as HTMLElement).closest("[data-line]");
                  const parsedLine = target ? Number.parseInt((target as HTMLElement).dataset.line ?? "1", 10) : 1;
                  const lineNum = Number.isFinite(parsedLine) ? parsedLine : 1;
                  if (!focusEditorLine(lineNum)) {
                    pendingPreviewLineRef.current = lineNum;
                  }
                  setViewMode("edit");
                }}
              />
            </div>
          )}
          {viewMode === "graph" && graph && (
            <section className="graphSurface">
              <GraphView
                graph={graph}
                activePath={activePath}
                embeddingsCache={embeddingsCache}
                notes={vault?.notes || []}
                healthReports={healthReports}
                onOpen={(path) => void selectNote(path)}
                onCreateLink={(targetPath) => activePath && void createGraphLink(activePath, targetPath)}
                onDeleteLink={(targetPath) => activePath && void deleteGraphLink(activePath, targetPath)}
                activeUnresolvedTarget={activeUnresolvedTarget}
                unresolvedLinks={unresolvedLinks}
                onSelectUnresolved={selectUnresolvedTarget}
                onOpenUnresolved={openUnresolvedTarget}
                onDraftUnresolved={draftUnresolvedTarget}
              />
            </section>
          )}
          {viewMode === "distill" && (
            <DistillWorkspace
              vault={vault}
              activePath={activePath}
              llmConfig={llmConfig}
              setLlmConfig={setLlmConfig}
              vaultConfig={vaultConfig}
              updateVaultConfig={updateVaultConfig}
              saveStoredLlmApiKey={saveStoredLlmApiKey}
              readStoredLlmApiKey={readStoredLlmApiKey}
              redactLlmConfig={redactLlmConfig}
              pruneExpiredPromptRuns={pruneExpiredPromptRuns}
              setStatus={setStatus}
              contextBundle={contextBundle}
              distillTab={distillTab}
              setDistillTab={setDistillTab}
              auditorSubTab={auditorSubTab}
              setAuditorSubTab={setAuditorSubTab}
              distillInputText={distillInputText}
              setDistillInputText={setDistillInputText}
              proposedEdits={proposedEdits}
              setProposedEdits={setProposedEdits}
              applyCheckedEdits={applyCheckedEdits}
              chatMessages={chatMessages}
              setChatMessages={setChatMessages}
              chatInput={chatInput}
              setChatInput={setChatInput}
              isLlmGenerating={isLlmGenerating}
              setIsLlmGenerating={setIsLlmGenerating}
              includeContext={includeContext}
              setIncludeContext={setIncludeContext}
              clearChatHistory={clearChatHistory}
              handleSendChatMessage={handleSendChatMessage}
              showLlmSettings={showLlmSettings}
              setShowLlmSettings={setShowLlmSettings}
              unresolvedLinks={unresolvedLinks}
              isScanningUnresolved={isScanningUnresolved}
              selectedUnresolvedTargets={selectedUnresolvedTargets}
              setSelectedUnresolvedTargets={unresolved.setSelectedUnresolvedTargets}
              bulkDrafts={bulkDrafts}
              setBulkDrafts={setBulkDrafts}
              isBulkProcessing={isBulkProcessing}
              runUnresolvedLinksScan={runUnresolvedLinksScan}
              handleSelectAllToggle={handleSelectAllToggle}
              runBulkDrafting={runBulkDrafting}
              applyStubDraft={applyStubDraft}
              draftStubNote={draftStubNote}
              onSelectNote={selectNote}
              onRefreshVault={async () => { await refreshVault(activePath); }}
              healthReports={healthReports}
              isScanningHealth={isScanningHealth}
              onRunHealthAudit={runHealthAudit}
              generateRepairForIssue={generateRepairForIssue}
              generateAllRepairsForNote={generateAllRepairsForNote}
              generatingRepairFor={generatingRepairFor}
              gitStatus={gitStatus}
              gitChanges={gitChanges}
              selectedGitFile={selectedGitFile}
              selectedGitFileStaged={selectedGitFileStaged}
              activeDiff={activeDiff}
              commitMessage={commitMessage}
              isGitLoading={isGitLoading}
              gitOutputLog={gitOutputLog}
              setCommitMessage={setCommitMessage}
              setSelectedGitFile={setSelectedGitFile}
              setSelectedGitFileStaged={setSelectedGitFileStaged}
              setGitOutputLog={setGitOutputLog}
              onRefreshGit={refreshGitWorkspace}
              onStageAll={handleGitStageAll}
              onStageFile={handleGitStageFile}
              onUnstageFile={handleGitUnstageFile}
              onCommit={handleGitCommit}
              onSuggestCommitMessage={handleSuggestCommitMessage}
              onPull={handleGitPull}
              onPush={handleGitPush}
              onLoadDiff={loadGitDiff}
              pendingPullWarning={pendingPullWarning}
              stashRetainedRef={stashRetainedRef}
              canDropStash={canDropStash}
              onPullAnyway={handlePullAnyway}
              onCancelPendingPull={cancelPendingPull}
              onStashAndPull={handleStashAndPull}
              onDropStash={handleDropStash}
              reviewQueue={reviewQueue}
            />
          )}
        </div>
      </section>

      <RightSidebar
        rightSidebarTab={rightSidebarTab}
        setRightSidebarTab={setRightSidebarTab}
        inspectorProps={{
          vault,
          activePath,
          draft,
          selectedContextCount,
          selectedContextCharacters,
          selectedContextTokens,
          contextLimit,
          isCustomLimit,
          setIsCustomLimit,
          handleLimitChange,
          bundlePreset,
          handlePresetChange,
          setBundlePreset,
          PRESETS,
          bundlePurpose,
          setBundlePurpose,
          bundleMode,
          setBundleMode,
          updateVaultConfig,
          setContextBundle,
          displayedCandidates,
          embeddingStatus,
          sortBy,
          setSortBy,
          filterBy,
          setFilterBy,
          selectedContextPaths,
          toggleContextCandidate,
          autoPruneCandidates,
          switchToShortMode,
          generateContextBundle,
          contextBundle,
          prevContextBundle,
          contextCandidates,
          showTemplates,
          setShowTemplates,
          promptInstruction,
          handlePromptInstructionChange,
          BUILTIN_TEMPLATES,
          vaultConfig,
          compileTemplate,
          deleteTemplate,
          saveAsTemplate,
          copyCombinedPrompt,
          copyContextBundle,
          presetForSettings,
          normalizeBundleMode,
        }}
        promptHistoryProps={{
          vaultConfig,
          activePath,
          archiveStatus,
          historySearchQuery,
          setHistorySearchQuery,
          historyActiveNoteOnly,
          setHistoryActiveNoteOnly,
          historyPresetFilter,
          setHistoryPresetFilter,
          expandedRunId,
          setExpandedRunId,
          diffRunId,
          setDiffRunId,
          diffResult,
          currentPromptHash,
          contextBundle,
          promptInstruction,
          selectNote,
          applyPromptRun,
          copyPromptRunQuestion,
          copyFullPromptFromHistory,
          deletePromptRun,
          loadPromptDiff,
          pruneArchivedPrompts,
          exportPromptRuns,
          handleImportArchiveFile,
          buildCombinedPrompt,
        }}
        embeddingsIndexProps={{
          llmConfig,
          vault,
          onUpdateLlmConfig: (patch) => {
            const next = { ...llmConfig, ...patch };
            setLlmConfig(next);
            void updateVaultConfig({ llmConfig: next });
          },
        }}
        linkSuggestionsProps={{
          activePath,
          context,
          linkSuggestions,
          backlinkSuggestions,
          contextCandidates,
          isLoadingBacklinks: isLoadingBacklinkSuggestions,
          onNavigateNote: selectNote,
          onInsertLinkAtCursor: insertWikiLinkAtCursor,
          onApplyWikiLinkSuggestion: applyWikiLinkSuggestion,
          onApplyBacklinkSuggestion: async (suggestion) =>
            (await applyBacklinkSuggestion(suggestion)).changedPaths.length > 0,
        }}
        vault={vault}
        context={context}
        activePath={activePath}
        showInboxTriage={activePath != null && isInboxPath(activePath)}
        status={status}
        capture={{
          draft: captureDraft,
          setDraft: setCaptureDraft,
          onCaptureToInbox: captureToInbox,
        }}
        inboxTriage={{
          captures: inboxCaptures,
          onPromote: promoteInboxCapture,
          onMarkProcessed: markInboxCaptureProcessed,
          setTriageCaptureToAppend,
        }}
        metadata={{
          suggestions: metadataSuggestions,
          isGenerating: isGeneratingMetadata,
          selectedTags: selectedSuggestedTags,
          selectedProperties: selectedSuggestedProperties,
          onGenerate: generateMetadataSuggestions,
          onToggleTag: handleToggleSuggestedTag,
          onToggleProperty: handleToggleSuggestedProperty,
          onApply: applyMetadataSuggestions,
          onClear: () => setMetadataSuggestions(null),
        }}
        snapshots={{
          items: snapshots,
          onRestore: restoreSnapshot,
        }}
        git={{
          status: gitStatus,
          onToggleAutoGit: toggleAutoGit,
        }}
      />
      </ModelDownloadContext.Provider>

      {triageCaptureToAppend && (
        <div className="modalOverlay" onClick={() => setTriageCaptureToAppend(null)}>
          <div className="modalContent" onClick={(event) => event.stopPropagation()}>
            <header className="modalHeader">
              <h3>Append Capture to Note</h3>
              <button className="closeButton" onClick={() => setTriageCaptureToAppend(null)}>&times;</button>
            </header>
            <div className="modalBody">
              <input
                type="text"
                placeholder="Search notes..."
                autoFocus
                value={noteSearchQuery}
                onChange={(event) => setNoteSearchQuery(event.target.value)}
              />
              <div className="noteList">
                {vault?.notes
                  .filter((note) => {
                    const q = noteSearchQuery.toLowerCase();
                    return note.title.toLowerCase().includes(q) || note.path.toLowerCase().includes(q);
                  })
                  .map((note) => (
                    <button
                      key={note.path}
                      className="noteSelectItem"
                      onClick={() => void handleAppendCapture(note.path)}
                    >
                      <strong>{note.title}</strong>
                      <span>{note.path}</span>
                    </button>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}


function isInboxPath(path: string): boolean {
  return /^Inbox\/.+\.md$/i.test(path);
}
