import { markdown } from "@codemirror/lang-markdown";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { vaultApi } from "../api";
import { askConfirm, isDesktopRuntime, pickVaultFolder } from "../api/dialog";
import type { ContextBundle, ContextBundleCandidate, FileTreeNode, NoteDocument, VaultSnapshot, VaultConfig, PromptRun, PromptTemplate, ProposedEdit, LlmConfig, LlmProvider, BacklinkSuggestion, NoteTemplate, StubDraftReview, UnresolvedLinkGroup, UnresolvedLinkSource } from "../api/types";
import { sendChatMessage, type ChatMessage } from "../api/llm";
import { getEmbedding } from "../api/embeddings";
import type { InboxCaptureBlock } from "../core/capture";
import type { GraphData, NoteMeta } from "../core/types";
import { estimateTokens } from "../core/contextBundle";
import { renderMarkdownPreview } from "./markdownPreview";
import { getStartupVaultPath, rememberVaultPath } from "./vaultStartup";
import { GraphView } from "./components/GraphView";
import { PromptHistoryPanel } from "./components/PromptHistoryPanel";
import { DistillWorkspace } from "./components/DistillWorkspace";
import { Sidebar } from "./components/Sidebar";
import { InspectorPanel } from "./components/InspectorPanel";
import { EditorToolbar } from "./components/EditorToolbar";
import { LinkSuggestionsSidebar } from "./components/LinkSuggestionsSidebar";
import { IngestPanel } from "./components/IngestPanel";
import { ConflictResolver } from "./components/ConflictResolver";
import { useGit } from "./hooks/useGit";
import { useEmbeddings } from "./hooks/useEmbeddings";
import { useSearch } from "./hooks/useSearch";
import { useVault } from "./hooks/useVault";
import { useContextBundle } from "./hooks/useContextBundle";
import { useLlm } from "./hooks/useLlm";
import { usePromptHistory } from "./hooks/usePromptHistory";
import { useStubDrafting } from "./hooks/useStubDrafting";
import { useLinkSuggestions } from "./hooks/useLinkSuggestions";
import { useInbox } from "./hooks/useInbox";
import { useReviewQueue } from "./hooks/useReviewQueue";
import { applyProposedEditToVault } from "./proposedEditApply";
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

export const DEFAULT_NOTE_TEMPLATES: NoteTemplate[] = [
  {
    name: "Meeting Notes",
    description: "Template for recording meetings, attendees, action items, and notes.",
    prompt: "A meeting notes document. Include frontmatter with 'type: meeting', 'date', and 'participants'. The body should have sections for 'Agenda', 'Discussion Notes', and 'Action Items' (with checkboxes)."
  },
  {
    name: "Project Spec",
    description: "Template for drafting technical specs, requirements, and milestones.",
    prompt: "A project spec document. Include frontmatter with 'type: project', 'status: planning', and 'owner'. The body should have sections for 'Background', 'Proposed Changes', and 'Milestones'."
  },
  {
    name: "Daily Log",
    description: "Template for documenting daily progress, blockers, and goals.",
    prompt: "A daily log entry. Include frontmatter with 'type: log' and 'date'. The body should have sections for 'Completed Today', 'Blockers', and 'Goals for Tomorrow'."
  }
];

type ViewMode = "split" | "edit" | "preview" | "graph" | "distill";

async function computeHash(content: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(12, "0").slice(0, 12);
  }
  const msgBuffer = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  return hashHex.slice(0, 12);
}

function llmApiKeyStorageKey(provider: LlmProvider): string {
  return `lattice:llm-api-key:${provider}`;
}

const apiKeysCache: Record<string, string> = {};

function readStoredLlmApiKey(provider: LlmProvider): string {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    return apiKeysCache[provider] || "";
  }
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return window.localStorage.getItem(llmApiKeyStorageKey(provider)) || "";
  } catch {
    return "";
  }
}

function saveStoredLlmApiKey(provider: LlmProvider, apiKey: string): void {
  const key = apiKey.trim();
  apiKeysCache[provider] = key;
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    void vaultApi.saveApiKey(provider, key);
    return;
  }
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (key) {
      window.localStorage.setItem(llmApiKeyStorageKey(provider), key);
    } else {
      window.localStorage.removeItem(llmApiKeyStorageKey(provider));
    }
  } catch {
    // localStorage may be unavailable in hardened or test environments.
  }
}

function hydrateLlmConfigSecrets(config: LlmConfig): LlmConfig {
  return { ...config, apiKey: readStoredLlmApiKey(config.provider) || config.apiKey || "" };
}

export const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: "summarize",
    name: "Summarize",
    template: "Provide a clear and concise summary of the key concepts, main ideas, and critical details from the provided context. Structure the response with bullet points for readability.",
    isSystem: true
  },
  {
    id: "code-review",
    name: "Code Review",
    template: "Perform a detailed code review of the source code in the context. Analyze code quality, potential bugs, performance bottlenecks, and adherence to clean coding best practices. Propose concrete improvements.",
    isSystem: true
  },
  {
    id: "critique",
    name: "Design Critique",
    template: "Critically analyze the design, architecture, or approach described in the context. Point out structural weaknesses, hidden assumptions, scalability concerns, and trade-offs. Recommend alternative solutions.",
    isSystem: true
  },
  {
    id: "todo",
    name: "Extract TODOs",
    template: "Scan the provided context and extract all explicit and implicit action items, TODOs, bugs to fix, or future extension ideas. Organize them by priority or component.",
    isSystem: true
  },
  {
    id: "document",
    name: "Documentation",
    template: "Generate comprehensive documentation for the concepts, components, or APIs present in the context. Use clear markdown headers, code block examples, and explanations of inputs and outputs.",
    isSystem: true
  }
];


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
    selectNote: (path) => selectNote(path),
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
  const [rightSidebarTab, setRightSidebarTab] = useState<"context" | "suggestions">("context");
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const previewScrollRef = useRef<HTMLElement | null>(null);
  const isSyncingScroll = useRef(false);
  const pendingPreviewLineRef = useRef<number | null>(null);
  const [activeUnresolvedTarget, setActiveUnresolvedTarget] = useState<string | null>(null);
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
    selectNote: (path) => selectNote(path),
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

  const runUnresolvedLinksScanRef = useRef<() => Promise<UnresolvedLinkGroup[]>>(async () => []);
  const draftStubNoteRef = useRef<(target: string, sources: UnresolvedLinkSource[]) => Promise<void>>(async () => {});

  const git = useGit({
    refreshVault,
    setActivePath,
    setDocument,
    setDraft,
    setViewMode,
    setDistillTab,
    setActiveUnresolvedTarget,
    setSelectedUnresolvedTargets: (targets) => stub.setSelectedUnresolvedTargets(targets),
    activePath,
    runUnresolvedLinksScan: () => runUnresolvedLinksScanRef.current(),
    draftStubNote: (target, sources) => draftStubNoteRef.current(target, sources),
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
  } = git;

  const stub = useStubDrafting({
    llmConfig,
    vault,
    activePath,
    setStatus,
    refreshVault,
    unresolvedLinks,
    setUnresolvedLinks,
    setIsScanningUnresolved,
    activeUnresolvedTarget,
    setActiveUnresolvedTarget,
  });
  const {
    selectedUnresolvedTargets, setSelectedUnresolvedTargets,
    bulkDrafts, setBulkDrafts,
    isBulkProcessing,
    runUnresolvedLinksScan,
    draftStubNote,
    runBulkDrafting,
    createSelectedStubs,
    handleSelectAllToggle,
    approveDraft,
    rejectDraft,
    approveAllDrafts,
    rejectAllDrafts,
  } = stub;
  runUnresolvedLinksScanRef.current = runUnresolvedLinksScan;
  draftStubNoteRef.current = draftStubNote;

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
    selectNote: (path) => selectNote(path),
  });

  const reviewQueue = useReviewQueue({
    inboxCaptures,
    bulkDrafts,
    proposedEdits,
    healthReports,
    backlinkSuggestions,
    gitStagedPaths: new Set(gitChanges.filter(c => c.staged).map(c => c.path)),
    onApplyInboxCapture: (id) => {
      void markInboxCaptureProcessed(id);
    },
    onApplyProposedEdit: (id) => applyProposedEditFromQueue(id),
    onApplyBacklinkSuggestion: async (id) => {
      const suggestion = backlinkSuggestions.find((item) => item.id === id);
      if (!suggestion) {
        return false;
      }
      await applyBacklinkSuggestion(suggestion);
      return true;
    },
    onApproveStubDraft: (target) => approveDraft(target),
    onRejectStubDraft: (target) => rejectDraft(target),
  });

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

  const applyBacklinkSuggestion = (suggestion: BacklinkSuggestion) =>
    applyBacklinkSuggestionBase(suggestion, refreshContext, runHealthAudit);

  function clearActiveNoteState() {
    setActivePath(null);
    setDocument(null);
    setDraft("");
    setContext(null);
    setContextCandidates([]);
    setSelectedContextPaths(new Set());
    setInboxCaptures([]);
  }

  const refreshArchiveStatus = async () => {
    try {
      const status = await vaultApi.getArchiveStatus();
      setArchiveStatus(status);
    } catch (e) {
      console.error("Failed to load archive status", e);
    }
  };

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
      if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
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
  }, [draft, vault?.notes]);

  // Real-time Background Embedding Synchronization
  useEffect(() => {
    const config = llmConfig;
    if (!config.provider || (!config.apiKey && config.provider !== "ollama" && config.provider !== "lm-studio")) {
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
  }, [draft, activePath, document?.path, document?.content, vaultConfig, llmConfig]);

  async function openVault(path: string) {
    const nextVault = await vaultApi.openVault(path);
    setVault(nextVault);
    setResults(nextVault.notes);
    clearActiveNoteState();
    setStatus(`Opened ${nextVault.rootPath}`);

    let loadedConfig: VaultConfig = {};
    let runtimeLlmConfig: LlmConfig = DEFAULT_LLM_CONFIG;
    try {
      const rawConfig = await vaultApi.getVaultConfig();
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
      try {
        setEmbeddingsCache(rawCache ? JSON.parse(rawCache) : {});
      } catch (e) {
        setEmbeddingsCache({});
      }

      if (loadedConfig.archiveRetentionPolicy && loadedConfig.archiveRetentionPolicy !== "none") {
        void pruneExpiredPromptRuns(loadedConfig.archiveRetentionPolicy, loadedConfig, false);
      }
    } catch (e) {
      console.error("Failed to load vault config", e);
    }

    if (nextVault.obsidianSettings?.detected) {
      setStatus("Imported Obsidian settings");
    }
    if (nextVault.notes[0]) {
      await selectNote(nextVault.notes[0].path, loadedConfig, nextVault.notes, runtimeLlmConfig);
    }
    setGraph(await vaultApi.getGraph());
    setGitStatus(await vaultApi.getGitStatus());
    setGitChanges([]);
    setSelectedGitFile(null);
    setActiveDiff(null);
    setCommitMessage("");
    setGitOutputLog(null);
    void refreshArchiveStatus();
    void runHealthAudit();
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
    setGraph(await vaultApi.getGraph());
    setGitStatus(await vaultApi.getGitStatus());
    if (selectedPath) {
      await selectNote(selectedPath, undefined, nextVault.notes, undefined, true);
    } else {
      clearActiveNoteState();
    }
    void refreshArchiveStatus();
    void runHealthAudit();
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
    await refreshContext(path, currentConfig, currentNotes, currentLlmConfig);
  }

  function normalizeRef(value: string): string {
    return value.replace(/\\/g, "/").replace(/\.md$/i, "").trim().toLowerCase();
  }

  async function refreshContext(path: string, currentConfig?: VaultConfig, currentNotes?: NoteMeta[], currentLlmConfig?: LlmConfig) {
    setMetadataSuggestions(null);
    setContext(await vaultApi.getNoteContext(path));
    setSnapshots(await vaultApi.listSnapshots(path));
    setContextBundle(null);
    const candidates = await vaultApi.getContextBundleCandidates(path);
    setContextCandidates(candidates);

    const configToUse = currentConfig ?? vaultConfigRef.current;
    const saved = configToUse.selectedPaths?.[path];
    if (saved && Array.isArray(saved)) {
      setSelectedContextPaths(new Set(saved));
    } else {
      setSelectedContextPaths(new Set(candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.path)));
    }

    const savedPrompt = configToUse.promptInstructions?.[path] || "";
    setPromptInstruction(savedPrompt);

    setInboxCaptures(isInboxPath(path) ? await vaultApi.getInboxCaptures(path) : []);
    setGraph(await vaultApi.getGraph());
    setGitStatus(await vaultApi.getGitStatus());

    try {
      const note = await vaultApi.readNote(path);
      const notesForSuggestions = currentNotes ?? vault?.notes ?? [];
      updateLinkSuggestions(note.content, notesForSuggestions);
      void updateSemanticRecommendations(path, currentLlmConfig ?? llmConfig, notesForSuggestions);
    } catch (e) {
      console.error("Failed to read note for suggestions/semantics", e);
    }
    void refreshBacklinkSuggestions(path);
  }

  async function saveActiveNote() {
    if (!document) {
      return;
    }

    const result = await vaultApi.saveNote(document.path, draft, document.revision);
    if (result.conflict) {
      setStatus("Conflict detected. Snapshot created before overwriting.");
      await refreshContext(document.path);
      return;
    }

    setDocument({ ...document, content: draft, revision: result.revision });
    setStatus(result.gitCommit ? `Saved and committed ${result.gitCommit}` : "Saved");
    await refreshContext(document.path);
    void runHealthAudit();
  }

  async function restoreSnapshot(snapshotId: string) {
    await vaultApi.restoreSnapshot(snapshotId);
    if (activePath) {
      await selectNote(activePath);
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
    await refreshContext(sourcePath);
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
    await refreshContext(sourcePath);
    void runHealthAudit();
  }

  async function applyProposedEditFromQueue(id: string): Promise<boolean> {
    return applySelectedProposedEdits(new Set([id]));
  }

  async function applyCheckedEdits() {
    await applySelectedProposedEdits(null);
  }

  async function applySelectedProposedEdits(selectedIds: ReadonlySet<string> | null): Promise<boolean> {
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

    let appliedCount = 0;
    const nextEdits = [...proposedEdits];

    for (let i = 0; i < nextEdits.length; i++) {
      const edit = nextEdits[i];
      if (!shouldApply(edit)) {
        continue;
      }

      try {
        nextEdits[i] = await applyProposedEditToVault(edit);
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
    return true;
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
    const name = window.prompt("Enter a name for this prompt template:");
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

  const isActiveNoteConflicted = activePath && (
    gitChanges.some(c => c.path === activePath && c.status === "conflict") ||
    (viewMode !== "distill" && viewMode !== "graph" && draft.includes("<<<<<<<") && draft.includes("=======") && draft.includes(">>>>>>>"))
  );

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
    const frame = requestAnimationFrame(() => {
      const pendingLine = pendingPreviewLineRef.current;
      if (pendingLine !== null && focusEditorLine(pendingLine)) {
        pendingPreviewLineRef.current = null;
      }
    });
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
        setVault={(v) => setVault((prev) => prev ? { ...prev, ...v } : prev)}
        onIngested={(path) => refreshVault(path)}
      />

      <ConflictResolver
        open={showConflictResolver}
        onClose={() => setShowConflictResolver(false)}
        onResolved={() => {
          setShowConflictResolver(false);
          void refreshGitWorkspace();
        }}
      />

      <section className="editorPane">
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
                  extensions={[markdown()]}
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
              setSelectedUnresolvedTargets={setSelectedUnresolvedTargets}
              bulkDrafts={bulkDrafts}
              setBulkDrafts={setBulkDrafts}
              isBulkProcessing={isBulkProcessing}
              runUnresolvedLinksScan={runUnresolvedLinksScan}
              handleSelectAllToggle={handleSelectAllToggle}
              runBulkDrafting={runBulkDrafting}
              createSelectedStubs={createSelectedStubs}
              approveDraft={approveDraft}
              rejectDraft={rejectDraft}
              approveAllDrafts={approveAllDrafts}
              rejectAllDrafts={rejectAllDrafts}
              draftStubNote={draftStubNote}
              onSelectNote={selectNote}
              onRefreshVault={async () => { await refreshVault(activePath); }}
              healthReports={healthReports}
              isScanningHealth={isScanningHealth}
              onRunHealthAudit={runHealthAudit}
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
              onPull={handleGitPull}
              onPush={handleGitPush}
              onLoadDiff={loadGitDiff}
              reviewQueue={reviewQueue}
            />
          )}
        </div>
      </section>

      <aside className="contextPane">
        <div className="rightSidebarTabs">
          <button
            type="button"
            className={rightSidebarTab === "context" ? "active" : ""}
            onClick={() => setRightSidebarTab("context")}
          >
            LLM Context
          </button>
          <button
            type="button"
            className={rightSidebarTab === "suggestions" ? "active" : ""}
            onClick={() => setRightSidebarTab("suggestions")}
          >
            Link Suggestions
          </button>
        </div>

        {rightSidebarTab === "suggestions" ? (
          <LinkSuggestionsSidebar
            activePath={activePath}
            context={context}
            linkSuggestions={linkSuggestions}
            backlinkSuggestions={backlinkSuggestions}
            contextCandidates={contextCandidates}
            isLoadingBacklinks={isLoadingBacklinkSuggestions}
            onNavigateNote={selectNote}
            onInsertLinkAtCursor={insertWikiLinkAtCursor}
            onApplyWikiLinkSuggestion={applyWikiLinkSuggestion}
            onApplyBacklinkSuggestion={applyBacklinkSuggestion}
          />
        ) : (
          <>
            <InspectorPanel
              vault={vault}
              activePath={activePath}
              draft={draft}
              selectedContextCount={selectedContextCount}
              selectedContextCharacters={selectedContextCharacters}
              selectedContextTokens={selectedContextTokens}
              contextLimit={contextLimit}
              isCustomLimit={isCustomLimit}
              setIsCustomLimit={setIsCustomLimit}
              handleLimitChange={handleLimitChange}
              bundlePreset={bundlePreset}
              handlePresetChange={handlePresetChange}
              setBundlePreset={setBundlePreset}
              PRESETS={PRESETS}
              bundlePurpose={bundlePurpose}
              setBundlePurpose={setBundlePurpose}
              bundleMode={bundleMode}
              setBundleMode={setBundleMode}
              updateVaultConfig={updateVaultConfig}
              setContextBundle={setContextBundle}
              displayedCandidates={displayedCandidates}
              embeddingStatus={embeddingStatus}
              sortBy={sortBy}
              setSortBy={setSortBy}
              filterBy={filterBy}
              setFilterBy={setFilterBy}
              selectedContextPaths={selectedContextPaths}
              toggleContextCandidate={toggleContextCandidate}
              autoPruneCandidates={autoPruneCandidates}
              switchToShortMode={switchToShortMode}
              generateContextBundle={generateContextBundle}
              contextBundle={contextBundle}
              prevContextBundle={prevContextBundle}
              contextCandidates={contextCandidates}
              showTemplates={showTemplates}
              setShowTemplates={setShowTemplates}
              promptInstruction={promptInstruction}
              handlePromptInstructionChange={handlePromptInstructionChange}
              BUILTIN_TEMPLATES={BUILTIN_TEMPLATES}
              vaultConfig={vaultConfig}
              compileTemplate={compileTemplate}
              deleteTemplate={deleteTemplate}
              saveAsTemplate={saveAsTemplate}
              copyCombinedPrompt={copyCombinedPrompt}
              copyContextBundle={copyContextBundle}
              presetForSettings={presetForSettings}
              normalizeBundleMode={normalizeBundleMode}
            />
            <PromptHistoryPanel
              vaultConfig={vaultConfig}
              activePath={activePath}
              archiveStatus={archiveStatus}
              historySearchQuery={historySearchQuery}
              setHistorySearchQuery={setHistorySearchQuery}
              historyActiveNoteOnly={historyActiveNoteOnly}
              setHistoryActiveNoteOnly={setHistoryActiveNoteOnly}
              historyPresetFilter={historyPresetFilter}
              setHistoryPresetFilter={setHistoryPresetFilter}
              expandedRunId={expandedRunId}
              setExpandedRunId={setExpandedRunId}
              diffRunId={diffRunId}
              setDiffRunId={setDiffRunId}
              diffResult={diffResult}
              currentPromptHash={currentPromptHash}
              contextBundle={contextBundle}
              promptInstruction={promptInstruction}
              selectNote={selectNote}
              applyPromptRun={applyPromptRun}
              copyPromptRunQuestion={copyPromptRunQuestion}
              copyFullPromptFromHistory={copyFullPromptFromHistory}
              deletePromptRun={deletePromptRun}
              loadPromptDiff={loadPromptDiff}
              pruneArchivedPrompts={pruneArchivedPrompts}
              exportPromptRuns={exportPromptRuns}
              handleImportArchiveFile={handleImportArchiveFile}
              buildCombinedPrompt={buildCombinedPrompt}
            />
            <section>
              <h2>Capture</h2>
              <textarea
                className="captureInput"
                placeholder="Paste an LLM answer, idea, or loose note..."
                value={captureDraft}
                onChange={(event) => setCaptureDraft(event.target.value)}
              />
              <p className="muted">{context ? `Related to [[${context.note.title}]]` : "No related note selected"}</p>
              <button onClick={() => void captureToInbox()} disabled={!vault || !captureDraft.trim()}>Capture to Inbox</button>
            </section>
            {vault?.obsidianSettings?.detected && (
              <section>
                <h2>Obsidian</h2>
                <p className="property">Readable line length: {vault.obsidianSettings.readableLineLength ? "On" : "Off"}</p>
                {vault.obsidianSettings.theme && <p className="property">Theme: {vault.obsidianSettings.theme}</p>}
                {vault.obsidianSettings.accentColor && <p className="property">Accent: {vault.obsidianSettings.accentColor}</p>}
                {vault.obsidianSettings.attachmentFolderPath && (
                  <p className="property">Attachments: <code>{vault.obsidianSettings.attachmentFolderPath}</code></p>
                )}
                {!!vault.obsidianSettings.cssSnippets?.length && (
                  <p className="property">Snippets: {vault.obsidianSettings.cssSnippets.join(", ")}</p>
                )}
                {vault.obsidianSettings.hotkeys && (
                  <p className="property">Hotkeys: {Object.keys(vault.obsidianSettings.hotkeys).length} custom hotkeys</p>
                )}
                {!!vault.obsidianSettings.enabledCorePlugins?.length && (
                  <p className="muted">{vault.obsidianSettings.enabledCorePlugins.length} core plugins detected</p>
                )}
              </section>
            )}
            {activePath && isInboxPath(activePath) && (
              <section>
                <h2>Inbox Triage</h2>
                {inboxCaptures.length ? inboxCaptures.map((capture) => (
                  <div key={capture.id} className="triageCard">
                    <strong>{capture.title}</strong>
                    {capture.relatedTitle && <small>Related: [[{capture.relatedTitle}]]</small>}
                    <p>{capture.body}</p>
                    <div className="inlineActions">
                      <button onClick={() => void promoteInboxCapture(capture.id)}>Create Note</button>
                      <button onClick={() => setTriageCaptureToAppend({ id: capture.id, title: capture.title })}>Append to Note</button>
                      <button onClick={() => void markInboxCaptureProcessed(capture.id)}>Mark Processed</button>
                    </div>
                  </div>
                )) : <p className="muted">No unprocessed captures</p>}
              </section>
            )}
            <section>
              <h2>Tags</h2>
              <div className="chips">
                {context?.note.tags.map((tag) => <span key={tag}>#{tag}</span>)}
              </div>
            </section>
            <section>
              <h2>Properties</h2>
              {Object.entries(context?.note.frontmatter ?? {}).map(([key, value]) => (
                <p key={key} className="property"><strong>{key}</strong><span>{value}</span></p>
              ))}
            </section>
            <section className="metadataSuggestionsSection">
              <h2>AI Metadata Suggestions</h2>
              {isGeneratingMetadata && (
                <p className="metadataSuggestionsLoading">Generating suggestions...</p>
              )}
              {!metadataSuggestions && !isGeneratingMetadata && (
                <button
                  className="suggest-btn"
                  disabled={!activePath}
                  onClick={() => void generateMetadataSuggestions()}
                >
                  Suggest
                </button>
              )}
              {metadataSuggestions && !isGeneratingMetadata && (
                <div className="metadataSuggestionsCard">
                  {metadataSuggestions.tags.length > 0 && (
                    <div className="suggestedTagsGroup">
                      <h3>Suggested Tags</h3>
                      {metadataSuggestions.tags.map((tag) => (
                        <label key={tag} className="suggestedTagLabel">
                          <input
                            type="checkbox"
                            checked={selectedSuggestedTags.has(tag)}
                            onChange={() => handleToggleSuggestedTag(tag)}
                          />
                          <span>#{tag}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  {Object.keys(metadataSuggestions.frontmatter).length > 0 && (
                    <div className="suggestedPropertiesGroup">
                      <h3>Suggested Properties</h3>
                      {Object.entries(metadataSuggestions.frontmatter).map(([key, value]) => (
                        <label key={key} className="suggestedPropertyLabel">
                          <input
                            type="checkbox"
                            checked={selectedSuggestedProperties.has(key)}
                            onChange={() => handleToggleSuggestedProperty(key)}
                          />
                          <strong>{key}:</strong> <span>{value}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <div className="metadataSuggestionsActions">
                    <button
                      className="apply-btn"
                      onClick={() => void applyMetadataSuggestions()}
                    >
                      Apply Selected
                    </button>
                    <button
                      className="clear-btn"
                      onClick={() => setMetadataSuggestions(null)}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}
            </section>
            <section>
              <h2>Snapshots</h2>
              {snapshots.map((snapshot) => (
                <button key={snapshot.id} onClick={() => void restoreSnapshot(snapshot.id)}>
                  {new Date(snapshot.createdAt).toLocaleTimeString()} · {snapshot.reason}
                </button>
              ))}
            </section>
            <section>
              <h2>Git</h2>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={gitStatus?.autoGitEnabled ?? false}
                  disabled={!gitStatus?.isRepo}
                  onChange={(event) => void toggleAutoGit(event.target.checked)}
                />
                <span>Auto commit</span>
              </label>
              <p className="muted">{gitStatus?.isRepo ? `Branch ${gitStatus.branch}` : "Not a Git vault"}</p>
            </section>
          </>
        )}
        <p className="status">{status}</p>
      </aside>

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
