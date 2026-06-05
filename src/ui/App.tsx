import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { vaultApi } from "../api";
import { askConfirm, isDesktopRuntime, pickVaultFolder } from "../api/dialog";
import type { ContextBundle, ContextBundleCandidate, FileTreeNode, GitStatus, NoteDocument, Snapshot, VaultSnapshot, VaultConfig, PromptRun, PromptTemplate, ProposedEdit, LlmConfig, LlmProvider } from "../api/types";
import { parseProposedEdits } from "../core/distillParser";
import { sendChatMessage, type ChatMessage } from "../api/llm";
import { getEmbedding, cosineSimilarity, type VectorCache } from "../api/embeddings";
import type { InboxCaptureBlock } from "../core/capture";
import type { GraphData, NoteContext, NoteMeta } from "../core/types";
import { estimateTokens } from "../core/contextBundle";
import { renderMarkdownPreview } from "./markdownPreview";
import { getStartupVaultPath, rememberVaultPath } from "./vaultStartup";

type ViewMode = "split" | "edit" | "preview" | "graph" | "distill";

export type PresetType = "custom" | "ask" | "refactor" | "summarize" | "plan" | "debug";

export const PRESETS: Record<PresetType, { label: string; purpose: string; mode: "short" | "standard" | "full" }> = {
  custom: {
    label: "Custom Preset",
    purpose: "",
    mode: "standard"
  },
  ask: {
    label: "Ask (Q&A)",
    purpose: "Answer questions based on the provided wiki context.",
    mode: "standard"
  },
  refactor: {
    label: "Refactor",
    purpose: "Review code structure, propose refactorings, or suggest quality improvements.",
    mode: "full"
  },
  summarize: {
    label: "Summarize",
    purpose: "Create a concise summary, key points, and structural takeaways.",
    mode: "short"
  },
  plan: {
    label: "Plan",
    purpose: "Develop an implementation plan, design document, or task breakdown.",
    mode: "standard"
  },
  debug: {
    label: "Debug",
    purpose: "Diagnose errors, trace bugs, or suggest unit tests to fix issues.",
    mode: "full"
  }
};

const VAULT_CONFIG_VERSION = 1;

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

function normalizeLlmConfig(value: any): LlmConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return {
    provider: typeof value.provider === "string" && ["openai", "anthropic", "gemini", "ollama", "custom"].includes(value.provider) ? value.provider as LlmProvider : "openai",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    model: typeof value.model === "string" ? value.model : "",
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : undefined,
    embeddingModel: typeof value.embeddingModel === "string" ? value.embeddingModel : undefined
  };
}

export function normalizeVaultConfig(config: any): VaultConfig {
  const preset = normalizePreset(config?.bundlePreset);
  const bundlePurpose = typeof config?.bundlePurpose === "string" ? config.bundlePurpose : PRESETS[preset].purpose;
  const bundleMode = normalizeBundleMode(config?.bundleMode, PRESETS[preset].mode);
  const normalized: VaultConfig = {
    version: Math.max(VAULT_CONFIG_VERSION, typeof config?.version === "number" ? config.version : VAULT_CONFIG_VERSION),
    contextLimit: Number.isFinite(config?.contextLimit) && config.contextLimit > 0 ? config.contextLimit : 8000,
    bundlePreset: preset,
    bundlePurpose,
    bundleMode,
    selectedPaths: normalizeSelectedPaths(config?.selectedPaths),
    promptInstructions: normalizePromptInstructions(config?.promptInstructions),
    promptRuns: normalizePromptRuns(config?.promptRuns, bundlePurpose),
    promptTemplates: normalizePromptTemplates(config?.promptTemplates),
    llmConfig: normalizeLlmConfig(config?.llmConfig),
    archiveRetentionPolicy: typeof config?.archiveRetentionPolicy === "string" ? config.archiveRetentionPolicy : "none"
  };
  return normalized;
}

function normalizeSelectedPaths(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, paths]) => typeof key === "string" && Array.isArray(paths))
      .map(([key, paths]) => [key, (paths as unknown[]).filter((path): path is string => typeof path === "string")])
  );
}

function normalizePromptInstructions(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => {
      return typeof entry[0] === "string" && typeof entry[1] === "string";
    })
  );
}

function normalizePromptRuns(value: unknown, fallbackPurpose: string): PromptRun[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((run): run is Record<string, unknown> => !!run && typeof run === "object" && !Array.isArray(run))
    .map((run, index) => {
      const preset = typeof run.preset === "string" && run.preset ? run.preset : "ask";
      const presetForFallbacks = normalizeLegacyPreset(preset);
      return {
        id: typeof run.id === "string" && run.id ? run.id : `legacy-run-${index + 1}`,
        question: typeof run.question === "string" ? run.question : "",
        selectedNotes: Array.isArray(run.selectedNotes) ? run.selectedNotes.filter((path): path is string => typeof path === "string") : [],
        preset,
        purpose: typeof run.purpose === "string" ? run.purpose : PRESETS[presetForFallbacks].purpose || fallbackPurpose,
        mode: normalizeBundleMode(run.mode, PRESETS[presetForFallbacks].mode),
        tokenCount: Number.isFinite(run.tokenCount) && Number(run.tokenCount) >= 0 ? Number(run.tokenCount) : 0,
        createdAt: typeof run.createdAt === "string" ? run.createdAt : "",
        activePath: typeof run.activePath === "string" ? run.activePath : "",
        promptHash: typeof run.promptHash === "string" ? run.promptHash : undefined,
        preview: typeof run.preview === "string" ? run.preview : undefined
      };
    });
}

function normalizePromptTemplates(value: unknown): PromptTemplate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((template): template is Record<string, unknown> => !!template && typeof template === "object" && !Array.isArray(template))
    .filter((template) => typeof template.name === "string" && typeof template.template === "string")
    .map((template, index) => ({
      id: typeof template.id === "string" && template.id ? template.id : `template-${index + 1}`,
      name: template.name as string,
      template: template.template as string,
      isSystem: typeof template.isSystem === "boolean" ? template.isSystem : false
    }));
}

function normalizePreset(value: unknown): PresetType {
  return typeof value === "string" && value in PRESETS ? value as PresetType : "ask";
}

function normalizeLegacyPreset(value: unknown): PresetType {
  if (value === "review") {
    return "refactor";
  }
  if (value === "write") {
    return "plan";
  }
  return normalizePreset(value);
}

function normalizeBundleMode(value: unknown, fallback: "short" | "standard" | "full"): "short" | "standard" | "full" {
  return value === "short" || value === "standard" || value === "full" ? value : fallback;
}

function presetForSettings(purpose: string, mode: "short" | "standard" | "full"): PresetType {
  const matched = Object.entries(PRESETS).find(([key, config]) => {
    return key !== "custom" && config.purpose === purpose && config.mode === mode;
  });
  return matched ? matched[0] as PresetType : "custom";
}

function buildCombinedPrompt(instruction: string, bundleMarkdown: string): string {
  return instruction.trim()
    ? `${instruction.trim()}\n\n---\n\n${bundleMarkdown}`
    : bundleMarkdown;
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

function simplePromptHash(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = (Math.imul(31, hash) + content.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16);
}

interface DiffLine {
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

export function App() {
  const [vault, setVault] = useState<VaultSnapshot | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [document, setDocument] = useState<NoteDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [context, setContext] = useState<NoteContext | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [propertyFilter, setPropertyFilter] = useState("");
  const [results, setResults] = useState<(NoteMeta & { similarity?: number })[]>([]);
  const [searchMode, setSearchMode] = useState<"keyword" | "semantic">("keyword");
  const [isSearchingSemantic, setIsSearchingSemantic] = useState(false);
  const [semanticSearchError, setSemanticSearchError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [contextBundle, setContextBundle] = useState<ContextBundle | null>(null);
  const [prevContextBundle, setPrevContextBundle] = useState<ContextBundle | null>(null);
  const [contextCandidates, setContextCandidates] = useState<ContextBundleCandidate[]>([]);
  const [selectedContextPaths, setSelectedContextPaths] = useState<Set<string>>(new Set());
  const [bundlePreset, setBundlePreset] = useState<PresetType>("ask");
  const [bundlePurpose, setBundlePurpose] = useState(PRESETS["ask"].purpose);
  const [bundleMode, setBundleMode] = useState<"short" | "standard" | "full">("standard");
  const [inboxCaptures, setInboxCaptures] = useState<InboxCaptureBlock[]>([]);
  const [triageCaptureToAppend, setTriageCaptureToAppend] = useState<{ id: string; title: string } | null>(null);
  const [noteSearchQuery, setNoteSearchQuery] = useState("");
  const [captureDraft, setCaptureDraft] = useState("");
  const [status, setStatus] = useState("Ready");
  const [sortBy, setSortBy] = useState<"score" | "title" | "reason">("score");
  const [filterBy, setFilterBy] = useState<string>("all");
  const [contextLimit, setContextLimit] = useState<number>(8000);
  const [isCustomLimit, setIsCustomLimit] = useState<boolean>(false);
  const [vaultConfig, setVaultConfig] = useState<VaultConfig>({});
  const vaultConfigRef = useRef<VaultConfig>({});
  const [promptInstruction, setPromptInstruction] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  const [historySearchQuery, setHistorySearchQuery] = useState("");
  const [historyActiveNoteOnly, setHistoryActiveNoteOnly] = useState(false);
  const [historyPresetFilter, setHistoryPresetFilter] = useState("");
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [archiveStatus, setArchiveStatus] = useState<{ fileCount: number; totalBytes: number } | null>(null);
  const [diffRunId, setDiffRunId] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<{ lines: DiffLine[]; regenerating: boolean; error?: string } | null>(null);
  const [currentPromptHash, setCurrentPromptHash] = useState<string | null>(null);
  const [distillInputText, setDistillInputText] = useState("");
  const [proposedEdits, setProposedEdits] = useState<ProposedEdit[]>([]);
  const [llmConfig, setLlmConfig] = useState<LlmConfig>({ provider: "openai", apiKey: "", model: "gpt-4o" });
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [distillTab, setDistillTab] = useState<"paste" | "chat">("paste");
  const [isLlmGenerating, setIsLlmGenerating] = useState(false);
  const [includeContext, setIncludeContext] = useState(true);
  const [showLlmSettings, setShowLlmSettings] = useState(false);
  const [linkSuggestions, setLinkSuggestions] = useState<{ text: string; path: string }[]>([]);
  const [embeddingStatus, setEmbeddingStatus] = useState("");

  const updateVaultConfig = async (updates: Partial<VaultConfig>) => {
    const nextConfig: VaultConfig = {
      version: VAULT_CONFIG_VERSION,
      ...vaultConfigRef.current,
      ...updates
    };
    vaultConfigRef.current = nextConfig;
    setVaultConfig(nextConfig);
    try {
      await vaultApi.saveVaultConfig(nextConfig);
    } catch (e) {
      console.error("Failed to save vault config", e);
    }
  };

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

  const handleLimitChange = (val: number) => {
    setContextLimit(val);
    void updateVaultConfig({ contextLimit: val });
  };

  useEffect(() => {
    void openVault(getStartupVaultPath(window.localStorage, isDesktopRuntime()));
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

  async function openVault(path: string) {
    const nextVault = await vaultApi.openVault(path);
    setVault(nextVault);
    setResults(nextVault.notes);
    setActivePath(null);
    setDocument(null);
    setDraft("");
    setContext(null);
    setContextCandidates([]);
    setSelectedContextPaths(new Set());
    setInboxCaptures([]);
    setStatus(`Opened ${nextVault.rootPath}`);

    let loadedConfig: VaultConfig = {};
    try {
      const rawConfig = await vaultApi.getVaultConfig();
      loadedConfig = normalizeVaultConfig(rawConfig);
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

      const llmCfg = loadedConfig.llmConfig || { provider: "openai", apiKey: "", model: "gpt-4o" };
      setLlmConfig(llmCfg);

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
      await selectNote(nextVault.notes[0].path, loadedConfig);
    }
    setGraph(await vaultApi.getGraph());
    setGitStatus(await vaultApi.getGitStatus());
    void refreshArchiveStatus();
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
      await selectNote(selectedPath);
    } else {
      setActivePath(null);
      setDocument(null);
      setDraft("");
      setContext(null);
      setContextCandidates([]);
      setSelectedContextPaths(new Set());
      setInboxCaptures([]);
    }
    void refreshArchiveStatus();
  }

  async function selectNote(path: string, currentConfig?: VaultConfig) {
    const note = await vaultApi.readNote(path);
    setActivePath(path);
    setDocument(note);
    setDraft(note.content);
    setViewMode("split");
    await refreshContext(path, currentConfig);
  }

  async function refreshContext(path: string, currentConfig?: VaultConfig) {
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
      updateLinkSuggestions(note.content, vault?.notes || []);
      void updateSemanticRecommendations(path, configToUse.llmConfig || llmConfig, vault?.notes || []);
    } catch (e) {
      console.error("Failed to read note for suggestions/semantics", e);
    }
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
  }

  async function handleSendChatMessage() {
    if (!chatInput.trim() || isLlmGenerating) {
      return;
    }

    const userText = chatInput.trim();
    setChatInput("");
    setIsLlmGenerating(true);

    const newMessages: ChatMessage[] = [...chatMessages, { role: "user", content: userText }];
    setChatMessages(newMessages);

    try {
      const payload: ChatMessage[] = [];
      let systemContent = "You are an expert wiki copilot. Use the local wiki context to answer user questions or propose wiki edits.";
      
      if (includeContext && contextBundle) {
        systemContent += `\n\nHere is the active context bundle:\n\n${contextBundle.markdown}`;
      }
      
      if (promptInstruction && promptInstruction.trim()) {
        systemContent += `\n\nCustom Instructions:\n${promptInstruction.trim()}`;
      }
      
      systemContent += `\n\nIf you want to suggest modifications to notes, format your edits inside the response using this tag pattern:
<propose_edit type="create|update|merge|delete" path="relative/path/to/note.md" new_path="optional/new/path.md">
<reason>Explain why this edit is suggested.</reason>
<content><![CDATA[New content for create, or target replacement content details]]></content>
<target_content><![CDATA[Exact text to replace in update/merge]]></target_content>
<replacement_content><![CDATA[New replacement text in update/merge]]></replacement_content>
</propose_edit>
You can suggest multiple edits. Do not include markdown wraps around the tags.`;

      payload.push({ role: "system", content: systemContent });
      payload.push(...newMessages);

      const response = await sendChatMessage(llmConfig, payload);
      
      const updatedMessages: ChatMessage[] = [...newMessages, { role: "assistant" as const, content: response }];
      setChatMessages(updatedMessages);

      const edits = parseProposedEdits(response);
      if (edits.length > 0) {
        setProposedEdits((prev) => {
          const filteredPrev = prev.filter(p => !edits.some(e => e.path === p.path && e.type === p.type));
          const checkedEdits = edits.map(e => ({ ...e, checked: true }));
          return [...filteredPrev, ...checkedEdits];
        });
        setStatus(`LLM proposed ${edits.length} wiki edit(s)`);
      }
    } catch (error) {
      console.error(error);
      const errMsg = error instanceof Error ? error.message : String(error);
      setChatMessages((prev) => [...prev, { role: "assistant" as const, content: `Error: ${errMsg}` }]);
      setStatus("LLM chat request failed");
    } finally {
      setIsLlmGenerating(false);
    }
  }

  function clearChatHistory() {
    setChatMessages([]);
  }

  function escapeRegExp(str: string) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function updateLinkSuggestions(content: string, notes: NoteMeta[]) {
    if (!activePath) {
      setLinkSuggestions([]);
      return;
    }
    
    const suggestions: { text: string; path: string }[] = [];
    for (const note of notes) {
      if (note.path === activePath) {
        continue;
      }
      const title = note.title.trim();
      if (!title) {
        continue;
      }

      const escaped = escapeRegExp(title);
      const isLinkedPattern = new RegExp(`\\[\\[${escaped}(?:\\|[^\\]]+)?\\]\\]`, "i");
      if (isLinkedPattern.test(content)) {
        continue;
      }

      const maskedText = content.replace(/\[\[[^\]]+\]\]/g, "####LINK####");
      const wordPattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
      if (wordPattern.test(maskedText)) {
        suggestions.push({ text: title, path: note.path });
      }
    }
    setLinkSuggestions(suggestions);
  }

  function applyWikiLinkSuggestion(text: string) {
    if (!draft) return;
    const escaped = escapeRegExp(text);
    const regex = new RegExp(`(?<!\\[\\[)(${escaped})(?!\\]\\])`, "g");
    const nextDraft = draft.replace(regex, `[[$1]]`);
    setDraft(nextDraft);
    if (vault?.notes) {
      updateLinkSuggestions(nextDraft, vault.notes);
    }
  }

  async function updateSemanticRecommendations(path: string, config: LlmConfig, notes: NoteMeta[]) {
    if (!config.provider || (!config.apiKey && config.provider !== "ollama")) {
      return;
    }
    
    setEmbeddingStatus("Semantic indexing...");
    try {
      const rawCache = await vaultApi.loadEmbeddingsCache();
      let cache: VectorCache = {};
      try {
        cache = JSON.parse(rawCache);
      } catch (e) {
        cache = {};
      }

      let cacheUpdated = false;
      const notesToProcess = vault?.notes || [];
      const noteContents: Record<string, string> = {};
      
      for (const note of notesToProcess) {
        const cached = cache[note.path];
        if (!cached || cached.contentHash !== note.contentHash) {
          try {
            const doc = await vaultApi.readNote(note.path);
            noteContents[note.path] = doc.content;
            const vector = await getEmbedding(config, doc.content);
            if (vector.length > 0) {
              cache[note.path] = {
                contentHash: note.contentHash,
                vector
              };
              cacheUpdated = true;
            }
          } catch (err) {
            console.error(`Failed to generate embedding for ${note.path}:`, err);
            setEmbeddingStatus("Embedding error (API unreachable)");
            return;
          }
        }
      }

      if (cacheUpdated) {
        await vaultApi.saveEmbeddingsCache(JSON.stringify(cache));
      }

      const activeEntry = cache[path];
      if (!activeEntry) {
        setEmbeddingStatus("Semantic indexing failed (Active note missing vector)");
        return;
      }

      const activeVector = activeEntry.vector;

      // Collect recommendations first
      const recommendedItems: { note: NoteMeta; similarity: number; score: number; reasonDetail: string }[] = [];
      for (const note of notesToProcess) {
        if (note.path === path) continue;
        const entry = cache[note.path];
        if (!entry) continue;

        const similarity = cosineSimilarity(activeVector, entry.vector);
        if (similarity >= 0.5) {
          const score = Math.min(9.5, Number((similarity * 10).toFixed(1)));
          const reasonDetail = `Semantic similarity: ${Math.round(similarity * 100)}%`;
          recommendedItems.push({ note, similarity, score, reasonDetail });
        }
      }

      // Read contents of recommended items sequentially or retrieve from noteContents
      const enrichedRecommended: { path: string; title: string; reasonDetail: string; score: number; excerpt: string; tokenEstimate: number; characterCount: number }[] = [];
      for (const item of recommendedItems) {
        let content = noteContents[item.note.path];
        if (content === undefined) {
          try {
            const doc = await vaultApi.readNote(item.note.path);
            content = doc.content;
            noteContents[item.note.path] = content;
          } catch (err) {
            console.error(`Failed to read content for recommendation: ${item.note.path}`, err);
            continue;
          }
        }
        enrichedRecommended.push({
          path: item.note.path,
          title: item.note.title,
          reasonDetail: item.reasonDetail,
          score: item.score,
          excerpt: content.slice(0, 100).replace(/\s+/g, " ").trim() + "...",
          tokenEstimate: estimateTokens(content),
          characterCount: content.length,
        });
      }

      setContextCandidates((prev) => {
        const next = [...prev];

        for (const item of enrichedRecommended) {
          const existingIdx = next.findIndex((c) => c.path === item.path);
          if (existingIdx !== -1) {
            const prevItem = next[existingIdx];
            next[existingIdx] = {
              ...prevItem,
              score: Math.max(prevItem.score, item.score),
              reasonDetail: prevItem.reason === "Recommended" ? item.reasonDetail : `${prevItem.reasonDetail} | ${item.reasonDetail}`
            };
          } else {
            next.push({
              path: item.path,
              title: item.title,
              reason: "Recommended",
              reasonDetail: item.reasonDetail,
              score: item.score,
              excerpt: item.excerpt,
              tokenEstimate: item.tokenEstimate,
              selected: false,
              characterCount: item.characterCount
            });
          }
        }

        return next.sort((a, b) => b.score - a.score);
      });

      setEmbeddingStatus("Semantic index updated");
    } catch (err) {
      console.error("Semantic recommendation error:", err);
      setEmbeddingStatus("Semantic index failed");
    }
  }

  async function runSemanticSearch(searchQuery: string) {
    const q = searchQuery.trim();
    if (!q) {
      setResults([]);
      setSemanticSearchError(null);
      return;
    }

    const config = vaultConfigRef.current.llmConfig || llmConfig;
    if (!config.provider || (!config.apiKey && config.provider !== "ollama")) {
      setSemanticSearchError("Please configure LLM API key / Ollama in the Distill Settings first.");
      return;
    }

    setIsSearchingSemantic(true);
    setSemanticSearchError(null);
    try {
      const rawCache = await vaultApi.loadEmbeddingsCache();
      let cache: VectorCache = {};
      try {
        cache = rawCache ? JSON.parse(rawCache) : {};
      } catch (e) {
        cache = {};
      }

      const notesToProcess = vault?.notes || [];
      let cacheUpdated = false;
      
      for (const note of notesToProcess) {
        const cached = cache[note.path];
        if (!cached || cached.contentHash !== note.contentHash) {
          try {
            const doc = await vaultApi.readNote(note.path);
            const vector = await getEmbedding(config, doc.content);
            if (vector.length > 0) {
              cache[note.path] = {
                contentHash: note.contentHash,
                vector
              };
              cacheUpdated = true;
            }
          } catch (err) {
            console.error(`Semantic search: failed to embed note ${note.path}:`, err);
          }
        }
      }

      if (cacheUpdated) {
        await vaultApi.saveEmbeddingsCache(JSON.stringify(cache));
      }

      const queryVector = await getEmbedding(config, q);
      if (queryVector.length === 0) {
        throw new Error("Could not compute embedding for query");
      }

      const searchResults: (NoteMeta & { similarity: number })[] = [];
      for (const note of notesToProcess) {
        const entry = cache[note.path];
        if (!entry) continue;

        const similarity = cosineSimilarity(queryVector, entry.vector);
        if (similarity >= 0.3) {
          searchResults.push({
            ...note,
            similarity
          });
        }
      }

      searchResults.sort((a, b) => b.similarity - a.similarity);
      setResults(searchResults);
    } catch (err) {
      console.error("Semantic search error:", err);
      const errMsg = err instanceof Error ? err.message : String(err);
      setSemanticSearchError(`Search failed: ${errMsg}`);
    } finally {
      setIsSearchingSemantic(false);
    }
  }

  async function runSearch(nextQuery = query, nextTag = tagFilter, nextProperty = propertyFilter, forceMode?: "keyword" | "semantic") {
    const mode = forceMode || searchMode;
    if (mode === "semantic") {
      await runSemanticSearch(nextQuery);
    } else {
      setSemanticSearchError(null);
      const frontmatter = parsePropertyFilter(nextProperty);
      const notes = await vaultApi.searchNotes({
        query: nextQuery,
        tags: nextTag ? [nextTag] : [],
        frontmatter
      });
      setResults(notes);
    }
  }

  async function restoreSnapshot(snapshotId: string) {
    await vaultApi.restoreSnapshot(snapshotId);
    if (activePath) {
      await selectNote(activePath);
      setStatus("Snapshot restored");
    }
  }

  async function toggleAutoGit(enabled: boolean) {
    await vaultApi.setAutoGit(enabled);
    setGitStatus(await vaultApi.getGitStatus());
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
  }

  async function createNoteInCurrentFolder() {
    const title = window.prompt("New note name");
    if (!title) {
      return;
    }
    try {
      const result = await vaultApi.createNote(currentFolderPath(activePath), title);
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Created ${result.selectedPath}`);
      if (result.selectedPath) {
        await selectNote(result.selectedPath);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function createFolderInCurrentFolder() {
    const name = window.prompt("New folder name");
    if (!name) {
      return;
    }
    try {
      const result = await vaultApi.createFolder(currentFolderPath(activePath), name);
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Created folder ${result.selectedPath}`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function renameTreeEntry(path: string) {
    const currentName = path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
    const newName = window.prompt("Rename", currentName);
    if (!newName || newName === currentName) {
      return;
    }
    try {
      const result = await vaultApi.renameEntry(path, newName);
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Renamed to ${result.selectedPath}`);
      if (result.selectedPath?.endsWith(".md")) {
        await selectNote(result.selectedPath);
      } else {
        await refreshVault(activePath);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function deleteTreeEntry(path: string, kind: FileTreeNode["kind"]) {
    const message = kind === "folder"
      ? `Delete empty folder "${path}"? Non-empty folders are refused.`
      : `Delete note "${path}"?`;
    if (!(await askConfirm(message, kind === "folder" ? "Delete Folder" : "Delete Note"))) {
      return;
    }
    try {
      const result = await vaultApi.deleteEntry(path);
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Deleted ${path}`);
      if (result.selectedPath) {
        await selectNote(result.selectedPath);
      } else {
        setActivePath(null);
        setDocument(null);
        setDraft("");
        setContext(null);
        setContextCandidates([]);
        setSelectedContextPaths(new Set());
        setInboxCaptures([]);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function generateContextBundle(overridePaths?: string[], overrideMode?: "short" | "standard" | "full", overridePreset?: PresetType) {
    if (!activePath) {
      return;
    }
    try {
      const paths = overridePaths ?? contextCandidates.filter((candidate) => selectedContextPaths.has(candidate.path)).map((candidate) => candidate.path);
      const mode = overrideMode ?? bundleMode;
      const bundle = await vaultApi.getContextBundle(activePath, {
        selectedPaths: paths,
        purpose: bundlePurpose,
        mode,
        preset: overridePreset ?? bundlePreset
      });
      setPrevContextBundle(contextBundle);
      setContextBundle(bundle);
      setStatus(`Context bundle includes ${bundle.notePaths.length} notes`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function autoPruneCandidates() {
    if (!activePath) return;
    let nextPaths = new Set(selectedContextPaths);
    const selectedNotes = contextCandidates.filter((candidate) => nextPaths.has(candidate.path));
    const recommendedSelected = selectedNotes
      .filter((candidate) => candidate.reason === "Recommended")
      .sort((a, b) => a.score - b.score);

    let prunedCount = 0;
    let currentBundle: ContextBundle;
    try {
      currentBundle = await vaultApi.getContextBundle(activePath, {
        selectedPaths: Array.from(nextPaths),
        purpose: bundlePurpose,
        mode: bundleMode,
        preset: bundlePreset
      });
    } catch (e) {
      setStatus(errorMessage(e));
      return;
    }

    let currentTokens = currentBundle.estimatedTokens;

    for (const note of recommendedSelected) {
      if (currentTokens <= contextLimit) {
        break;
      }
      nextPaths.delete(note.path);
      prunedCount++;
      try {
        currentBundle = await vaultApi.getContextBundle(activePath, {
          selectedPaths: Array.from(nextPaths),
          purpose: bundlePurpose,
          mode: bundleMode,
          preset: bundlePreset
        });
        currentTokens = currentBundle.estimatedTokens;
      } catch (e) {
        setStatus(errorMessage(e));
        return;
      }
    }

    setSelectedContextPaths(nextPaths);
    setContextBundle(currentBundle);

    if (activePath) {
      const currentSelected = vaultConfigRef.current.selectedPaths ?? {};
      const nextSelected = {
        ...currentSelected,
        [activePath]: Array.from(nextPaths)
      };
      void updateVaultConfig({ selectedPaths: nextSelected });
    }

    if (prunedCount > 0 && currentTokens <= contextLimit) {
      setStatus(`Auto-pruned ${prunedCount} recommended note(s) to fit under the limit (Final: ${currentTokens.toLocaleString()} tokens).`);
    } else if (prunedCount > 0) {
      setStatus(`Auto-pruned ${prunedCount} recommended note(s), but bundle still exceeds the limit (Final: ${currentTokens.toLocaleString()} tokens).`);
    } else if (currentTokens > contextLimit) {
      setStatus("No recommended notes to prune; try Short mode or deselect required notes.");
    } else {
      setStatus("No recommended notes to prune or already under limit.");
    }
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
        void refreshArchiveStatus();
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

  async function applyPromptRun(run: PromptRun) {
    try {
      const currentSelected = vaultConfigRef.current.selectedPaths ?? {};
      const currentPrompts = vaultConfigRef.current.promptInstructions ?? {};
      const presetForUi = normalizeLegacyPreset(run.preset);

      const nextConfig: VaultConfig = {
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
      };

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
      void refreshArchiveStatus();
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
      void refreshArchiveStatus();
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

      const updated = {
        ...currentConfig,
        promptRuns: nextRuns
      };

      await vaultApi.saveVaultConfig(updated);
      setVaultConfig(updated);
      vaultConfigRef.current = updated;
      
      const activeRunIds = nextRuns.map((r) => r.id);
      await vaultApi.pruneArchivedPrompts(activeRunIds);

      void refreshArchiveStatus();
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
          void refreshArchiveStatus();
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
        // Fallback to regeneration
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

  async function applyCheckedEdits() {
    const checkedEdits = proposedEdits.filter((edit) => edit.checked && !edit.applied);
    if (checkedEdits.length === 0) {
      return;
    }

    const destructiveCount = checkedEdits.filter((edit) => edit.type === "delete" || edit.type === "merge").length;
    const message = destructiveCount > 0
      ? `Apply ${checkedEdits.length} proposed wiki edit(s), including ${destructiveCount} destructive edit(s)?`
      : `Apply ${checkedEdits.length} proposed wiki edit(s)?`;
    if (!(await askConfirm(message, "Apply Proposed Wiki Edits"))) {
      return;
    }

    let appliedCount = 0;
    const nextEdits = [...proposedEdits];

    for (let i = 0; i < nextEdits.length; i++) {
      const edit = nextEdits[i];
      if (edit.applied || !edit.checked) {
        continue;
      }

      try {
        if (edit.type === "create") {
          const pathParts = edit.path.split("/");
          const title = pathParts.pop()?.replace(/\.md$/, "") || "";
          const parent = pathParts.length > 0 ? pathParts.join("/") : null;

          const result = await vaultApi.createNote(parent, title);
          await vaultApi.saveNote(result.selectedPath || edit.path, edit.content || "", "");
          appliedCount++;
          nextEdits[i] = { ...edit, applied: true, path: result.selectedPath || edit.path };
        } else if (edit.type === "update") {
          const doc = await vaultApi.readNote(edit.path);
          const target = edit.targetContent || "";
          const replacement = edit.replacementContent || "";

          if (!doc.content.includes(target)) {
            throw new Error(`Target content not found in ${edit.path}`);
          }

          const updatedContent = doc.content.replace(target, replacement);
          await vaultApi.saveNote(edit.path, updatedContent, doc.revision);
          appliedCount++;
          nextEdits[i] = { ...edit, applied: true };
        } else if (edit.type === "delete") {
          await vaultApi.deleteEntry(edit.path);
          appliedCount++;
          nextEdits[i] = { ...edit, applied: true };
        } else if (edit.type === "merge") {
          let targetPath = edit.newPath || "";
          let existingRevision = "";
          try {
            const doc = await vaultApi.readNote(targetPath);
            existingRevision = doc.revision;
          } catch (_) {
            const pathParts = targetPath.split("/");
            const title = pathParts.pop()?.replace(/\.md$/, "") || "";
            const parent = pathParts.length > 0 ? pathParts.join("/") : null;
            const result = await vaultApi.createNote(parent, title);
            targetPath = result.selectedPath || targetPath;
          }

          await vaultApi.saveNote(targetPath, edit.content || "", existingRevision);
          await vaultApi.deleteEntry(edit.path);
          appliedCount++;
          nextEdits[i] = { ...edit, applied: true };
        }
      } catch (err) {
        console.error("Failed to apply proposed edit", edit, err);
        setStatus(`Error applying edit to ${edit.path}: ${errorMessage(err)}`);
        setProposedEdits(nextEdits);
        return;
      }
    }

    setProposedEdits(nextEdits);
    setStatus(`Successfully applied ${appliedCount} wiki edit(s).`);
    await refreshVault(activePath);
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

  async function captureToInbox() {
    if (!vault || !captureDraft.trim()) {
      return;
    }
    try {
      const result = await vaultApi.captureToInbox({
        content: captureDraft,
        relatedPath: activePath,
        capturedAt: new Date().toISOString()
      });
      setCaptureDraft("");
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Captured to ${result.selectedPath}`);
      if (result.selectedPath) {
        await selectNote(result.selectedPath);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function promoteInboxCapture(captureId: string) {
    if (!activePath) {
      return;
    }
    const title = window.prompt("New note title");
    if (!title) {
      return;
    }
    try {
      const result = await vaultApi.promoteInboxCapture({
        inboxPath: activePath,
        captureId,
        title
      });
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Promoted to ${result.selectedPath}`);
      if (result.selectedPath) {
        await selectNote(result.selectedPath);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function markInboxCaptureProcessed(captureId: string) {
    if (!activePath) {
      return;
    }
    try {
      const result = await vaultApi.markInboxCaptureProcessed(activePath, captureId);
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus("Capture marked processed");
      await selectNote(activePath);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function handleAppendCapture(targetPath: string) {
    if (!activePath || !triageCaptureToAppend) {
      return;
    }
    try {
      const result = await vaultApi.appendInboxCapture({
        inboxPath: activePath,
        captureId: triageCaptureToAppend.id,
        targetPath
      });
      setTriageCaptureToAppend(null);
      setNoteSearchQuery("");
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Appended capture to ${result.selectedPath}`);
      if (result.selectedPath) {
        await selectNote(result.selectedPath);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  const html = useMemo(() => ({ __html: renderMarkdownPreview(draft) }), [draft]);
  const allTags = useMemo(() => Array.from(new Set(vault?.notes.flatMap((note) => note.tags) ?? [])).sort(), [vault]);
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

  return (
    <main className="workspace">
      <aside className="sidebar">
        <div className="brand">
          <strong>Lattice</strong>
          <span>{vault?.rootPath ?? "No vault"}</span>
        </div>
        <button className="primary" onClick={() => void chooseVaultFolder()}>Open vault</button>
        <SearchPanel
          query={query}
          tagFilter={tagFilter}
          propertyFilter={propertyFilter}
          tags={allTags}
          searchMode={searchMode}
          onSearchModeChange={(mode) => {
            setSearchMode(mode);
            void runSearch(query, tagFilter, propertyFilter, mode);
          }}
          onSubmit={() => {
            void runSearch(query, tagFilter, propertyFilter);
          }}
          onQuery={(value) => {
            setQuery(value);
            if (searchMode === "keyword") {
              void runSearch(value, tagFilter, propertyFilter);
            }
          }}
          onTag={(value) => {
            setTagFilter(value);
            void runSearch(query, value, propertyFilter);
          }}
          onProperty={(value) => {
            setPropertyFilter(value);
            void runSearch(query, tagFilter, value);
          }}
        />
        <section className="tree">
          <div className="sectionHeader">
            <h2>Files</h2>
            <div className="inlineActions">
              <button title="New note" onClick={() => void createNoteInCurrentFolder()}>+</button>
              <button title="New folder" onClick={() => void createFolderInCurrentFolder()}>Folder</button>
            </div>
          </div>
          {vault?.tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              activePath={activePath}
              onSelect={(path) => void selectNote(path)}
              onRename={(path) => void renameTreeEntry(path)}
              onDelete={(path, kind) => void deleteTreeEntry(path, kind)}
            />
          ))}
        </section>
        <section className="results">
          <h2>Search {searchMode === "semantic" ? "(Semantic)" : ""}</h2>
          {isSearchingSemantic && (
            <div className="searchLoadingText">
              <span className="spinner">⌛</span> Searching semantically...
            </div>
          )}
          {semanticSearchError && (
            <div className="searchErrorText">{semanticSearchError}</div>
          )}
          {!isSearchingSemantic && results.length === 0 && query.trim() !== "" && (
            <div className="muted" style={{ padding: "4px 0" }}>No notes found.</div>
          )}
          {!isSearchingSemantic && results.map((note) => (
            <button key={note.path} className="result" onClick={() => void selectNote(note.path)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                <strong>{note.title}</strong>
                {note.similarity !== undefined && (
                  <span className="similarityBadge">
                    {Math.round(note.similarity * 100)}% Match
                  </span>
                )}
              </div>
              <span>{note.path}</span>
            </button>
          ))}
        </section>
      </aside>

      <section className="editorPane">
        <header className="topbar">
          <div>
            <strong>{viewMode === "distill" ? "LLM Distill Workspace" : (context?.note.title ?? "Select a note")}</strong>
            <span>{viewMode === "distill" ? "Compounding Memory Pipeline" : activePath}</span>
          </div>
          <div className="segmented">
            <button className={viewMode === "split" ? "active" : ""} onClick={() => setViewMode("split")}>Split</button>
            <button className={viewMode === "edit" ? "active" : ""} onClick={() => setViewMode("edit")}>Edit</button>
            <button className={viewMode === "preview" ? "active" : ""} onClick={() => setViewMode("preview")}>Preview</button>
            <button className={viewMode === "graph" ? "active" : ""} onClick={() => setViewMode("graph")}>Graph</button>
            <button className={viewMode === "distill" ? "active" : ""} onClick={() => setViewMode("distill")}>Distill</button>
          </div>
          {viewMode !== "distill" && <button className="primary" onClick={() => void saveActiveNote()}>Save</button>}
        </header>

        <div className={`editorWorkspace ${viewMode === "split" ? "split" : "single"}`}>
          {(viewMode === "split" || viewMode === "edit") && (
            <section className="editorSurface">
              <CodeMirror
                value={draft}
                height="100%"
                extensions={[markdown()]}
                theme="light"
                basicSetup={{ lineNumbers: true, foldGutter: true }}
                onChange={setDraft}
              />
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
            <article
              className={`preview previewSurface ${vault?.obsidianSettings?.readableLineLength ? "previewReadable" : ""}`}
              dangerouslySetInnerHTML={html}
            />
          )}
          {viewMode === "graph" && graph && (
            <section className="graphSurface">
              <GraphView
                graph={graph}
                activePath={activePath}
                onOpen={(path) => void selectNote(path)}
                onCreateLink={(targetPath) => activePath && void createGraphLink(activePath, targetPath)}
                onDeleteLink={(targetPath) => activePath && void deleteGraphLink(activePath, targetPath)}
              />
            </section>
          )}
          {viewMode === "distill" && (
            <section className="distillSurface">
              <div className="distillWorkspaceLayout">
                <div className="distillLeftCol">
                  <div className="distillTabHeader">
                    <button
                      className={distillTab === "paste" ? "active" : ""}
                      onClick={() => setDistillTab("paste")}
                    >
                      Paste Raw Input
                    </button>
                    <button
                      className={distillTab === "chat" ? "active" : ""}
                      onClick={() => setDistillTab("chat")}
                    >
                      Chat with LLM
                    </button>
                  </div>

                  {distillTab === "paste" ? (
                    <div className="distillInputArea">
                      <h3>Raw Input Context</h3>
                      <textarea
                        className="distillTextarea"
                        value={distillInputText}
                        onChange={(e) => setDistillInputText(e.target.value)}
                        placeholder="Paste raw conversation logs, inbox captures, or meeting notes here to distill into structured wiki page proposed edits..."
                      />
                      <div className="distillActions">
                        <button
                          type="button"
                          onClick={() => {
                            const mockPrompt = `<propose_edit type="create" path="Research/Compounding Memory.md">
  <reason>Documenting the core mechanism of LLM wiki maintenance.</reason>
  <content># Compounding Memory

Persistent synthesis allows LLMs to read and write directly to the wiki rather than searching raw chunks.
- **Persistent synthesis**: Continually updating a core wiki page.
- **LLM-editable Markdown**: Simple structure.
- **Maintenance loop**: Compounding knowledge over time.</content>
</propose_edit>

<propose_edit type="update" path="Home.md">
  <reason>Link the new Compounding Memory research note.</reason>
  <target_content>Welcome to the local wiki workspace!</target_content>
  <replacement_content>Welcome to the local wiki workspace! Explore the new [[Research/Compounding Memory]] note.</replacement_content>
</propose_edit>

<propose_edit type="delete" path="TempDraft.md">
  <reason>Clean up old draft note.</reason>
</propose_edit>

<propose_edit type="merge" path="StaleNotes.md" new_path="Home.md">
  <reason>Merge outdated stale notes into Home wiki page.</reason>
  <content>Welcome to the local wiki workspace! Explore the new [[Research/Compounding Memory]] note. Also merging relevant guidelines here.</content>
</propose_edit>`;
                            setDistillInputText(mockPrompt);
                          }}
                        >
                          Load Mock Proposal
                        </button>
                        <button
                          className="primary"
                          type="button"
                          onClick={() => {
                            const parsed = parseProposedEdits(distillInputText);
                            const checkedParsed = parsed.map(p => ({ ...p, checked: true }));
                            setProposedEdits(checkedParsed);
                            setStatus(`Extracted ${checkedParsed.length} proposed edit(s).`);
                          }}
                        >
                          Propose Wiki Edits
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="distillChatArea">
                      <div className="chatHeader">
                        <h3>LLM Copilot Chat</h3>
                        <div className="chatHeaderActions">
                          <button
                            type="button"
                            className="textButton"
                            onClick={() => setShowLlmSettings(!showLlmSettings)}
                          >
                            ⚙️ {showLlmSettings ? "Close Settings" : "LLM Settings"}
                          </button>
                          <button
                            type="button"
                            className="textButton"
                            onClick={clearChatHistory}
                            disabled={chatMessages.length === 0}
                          >
                            🗑️ Clear Chat
                          </button>
                        </div>
                      </div>

                      {showLlmSettings && (
                        <div className="llmSettingsPanel">
                          <h4>LLM Configuration</h4>
                          <div className="formGroup">
                            <label>Provider</label>
                            <select
                              value={llmConfig.provider}
                              onChange={(e) => {
                                const prov = e.target.value as LlmProvider;
                                const defaultModels: Record<LlmProvider, string> = {
                                  openai: "gpt-4o",
                                  anthropic: "claude-3-5-sonnet-20240620",
                                  gemini: "gemini-1.5-pro",
                                  ollama: "llama3",
                                  custom: "gpt-4o"
                                };
                                const defaultBases: Record<LlmProvider, string> = {
                                  openai: "",
                                  anthropic: "",
                                  gemini: "",
                                  ollama: "http://localhost:11434",
                                  custom: "http://localhost:1234/v1"
                                };
                                setLlmConfig(prev => ({
                                  ...prev,
                                  provider: prov,
                                  model: defaultModels[prov],
                                  baseUrl: defaultBases[prov] || undefined
                                }));
                              }}
                            >
                              <option value="openai">OpenAI</option>
                              <option value="anthropic">Anthropic</option>
                              <option value="gemini">Google Gemini</option>
                              <option value="ollama">Ollama (Local)</option>
                              <option value="custom">Custom (OpenAI-compatible)</option>
                            </select>
                          </div>

                          <div className="formGroup">
                            <label>Model</label>
                            <input
                              type="text"
                              value={llmConfig.model}
                              onChange={(e) => setLlmConfig(prev => ({ ...prev, model: e.target.value }))}
                              placeholder="e.g. gpt-4o, llama3"
                            />
                          </div>

                          {llmConfig.provider !== "ollama" && (
                            <div className="formGroup">
                              <label>API Key</label>
                              <input
                                type="password"
                                value={llmConfig.apiKey}
                                onChange={(e) => setLlmConfig(prev => ({ ...prev, apiKey: e.target.value }))}
                                placeholder="Enter API Key"
                              />
                            </div>
                          )}

                          {(llmConfig.provider === "ollama" || llmConfig.provider === "custom") && (
                            <div className="formGroup">
                              <label>Base URL</label>
                              <input
                                type="text"
                                value={llmConfig.baseUrl || ""}
                                onChange={(e) => setLlmConfig(prev => ({ ...prev, baseUrl: e.target.value }))}
                                placeholder={llmConfig.provider === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1"}
                              />
                            </div>
                          )}

                          {(llmConfig.provider === "ollama" || llmConfig.provider === "openai" || llmConfig.provider === "custom") && (
                            <div className="formGroup">
                              <label>Embedding Model</label>
                              <input
                                type="text"
                                value={llmConfig.embeddingModel || ""}
                                onChange={(e) => setLlmConfig(prev => ({ ...prev, embeddingModel: e.target.value }))}
                                placeholder={llmConfig.provider === "ollama" ? "all-minilm" : "text-embedding-3-small"}
                              />
                            </div>
                          )}

                          <div className="settingsSection" style={{ marginTop: "12px", borderTop: "1px dashed #cbd5e1", paddingTop: "12px", marginBottom: "12px" }}>
                            <h4 style={{ margin: "0 0 8px 0", fontSize: "12px", color: "#344054" }}>Prompt Archive Settings</h4>
                            <div className="formGroup">
                              <label>Auto-Pruning Policy</label>
                              <select
                                value={vaultConfig.archiveRetentionPolicy || "none"}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  void updateVaultConfig({
                                    archiveRetentionPolicy: val
                                  });
                                }}
                              >
                                <option value="none">Keep all history indefinitely</option>
                                <option value="7">Prune runs older than 7 days</option>
                                <option value="30">Prune runs older than 30 days</option>
                                <option value="90">Prune runs older than 90 days</option>
                              </select>
                            </div>
                            <button
                              type="button"
                              className="btnPruneExpired"
                              style={{ width: "100%", marginTop: "6px", fontSize: "11px", padding: "4px 8px" }}
                              onClick={() => void pruneExpiredPromptRuns(vaultConfig.archiveRetentionPolicy || "none")}
                            >
                              Prune Expired Runs Now
                            </button>
                          </div>

                          <button
                            type="button"
                            className="primary btnSaveSettings"
                            onClick={() => {
                              void updateVaultConfig({ llmConfig });
                              setShowLlmSettings(false);
                              setStatus("LLM settings saved to vault config");
                            }}
                          >
                            Save Settings
                          </button>
                        </div>
                      )}

                      <div className="chatMessagesBox">
                        {chatMessages.length === 0 ? (
                          <div className="chatEmptyState">
                            <p>Ask a question or request page edits using the wiki context.</p>
                            <p className="hint">Try asking: "Propose a new note summarizing the core features of React."</p>
                          </div>
                        ) : (
                          chatMessages.map((msg, idx) => (
                            <div key={idx} className={`chatMessageBubble ${msg.role}`}>
                              <span className="messageSender">{msg.role === "user" ? "You" : "Copilot"}</span>
                              <div className="messageText">{msg.content}</div>
                            </div>
                          ))
                        )}
                        {isLlmGenerating && (
                          <div className="chatMessageBubble assistant generating">
                            <span className="messageSender">Copilot</span>
                            <div className="messageText">Thinking...</div>
                          </div>
                        )}
                      </div>

                      <div className="chatInputControls">
                        <div className="chatContextOption">
                          <label>
                            <input
                              type="checkbox"
                              checked={includeContext}
                              onChange={(e) => setIncludeContext(e.target.checked)}
                            />
                            Include active context bundle ({contextBundle ? `${contextBundle.notePaths.length} note(s)` : "None"})
                          </label>
                        </div>
                        <div className="chatInputRow">
                          <textarea
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                void handleSendChatMessage();
                              }
                            }}
                            placeholder="Message LLM copilot... (Press Enter to send)"
                          />
                          <button
                            type="button"
                            className="primary"
                            disabled={!chatInput.trim() || isLlmGenerating}
                            onClick={() => void handleSendChatMessage()}
                          >
                            Send
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="distillRightCol">
                  <div className="proposedEditsHeader">
                    <h3>Proposed Edits ({proposedEdits.filter(p => !p.applied).length} pending)</h3>
                    <button
                      className="primary"
                      disabled={proposedEdits.filter(p => p.checked && !p.applied).length === 0}
                      onClick={() => void applyCheckedEdits()}
                    >
                      Apply Checked Edits
                    </button>
                  </div>

                  {proposedEdits.length === 0 ? (
                    <div className="noProposalsBox">
                      <span style={{ color: "#64748b" }}>No proposed edits extracted yet. Paste context and click "Propose Wiki Edits".</span>
                    </div>
                  ) : (
                    <div className="proposalsList">
                      {proposedEdits.map((edit) => (
                        <div
                          key={edit.id}
                          className={`proposalCard ${edit.applied ? "applied" : ""}`}
                        >
                          <div className="proposalCardHeader">
                            <label className="proposalCheckboxLabel">
                              <input
                                type="checkbox"
                                checked={!!edit.checked}
                                disabled={edit.applied}
                                onChange={(e) => {
                                  setProposedEdits(prev =>
                                    prev.map(p => p.id === edit.id ? { ...p, checked: e.target.checked } : p)
                                  );
                                }}
                              />
                              <span className="proposalPath">{edit.path}</span>
                            </label>
                            <span className={`proposalBadge ${edit.type}`}>{edit.type}</span>
                            {edit.applied && <span className="appliedBadge">✓ Applied</span>}
                          </div>

                          {edit.reason && (
                            <div className="proposalReason">
                              <strong>Reason:</strong> {edit.reason}
                            </div>
                          )}

                          <div className="proposalBody">
                            {edit.type === "create" && (
                              <div className="proposalEditor">
                                <label>Proposed Content:</label>
                                <textarea
                                  className="proposalTextarea"
                                  value={edit.content || ""}
                                  disabled={edit.applied}
                                  onChange={(e) => {
                                    setProposedEdits(prev =>
                                      prev.map(p => p.id === edit.id ? { ...p, content: e.target.value } : p)
                                    );
                                  }}
                                />
                              </div>
                            )}

                            {edit.type === "update" && (
                              <div className="proposalDiffView">
                                <div className="diffOriginal">
                                  <span className="diffLabel">Target Segment (Search):</span>
                                  <pre>{edit.targetContent}</pre>
                                </div>
                                <div className="diffReplacement">
                                  <span className="diffLabel">Replacement Segment:</span>
                                  <div className="proposalEditor">
                                    <textarea
                                      className="proposalTextarea"
                                      value={edit.replacementContent || ""}
                                      disabled={edit.applied}
                                      onChange={(e) => {
                                        setProposedEdits(prev =>
                                          prev.map(p => p.id === edit.id ? { ...p, replacementContent: e.target.value } : p)
                                        );
                                      }}
                                    />
                                  </div>
                                </div>
                              </div>
                            )}

                            {edit.type === "delete" && (
                              <div className="proposalDeleteNotice">
                                This action will delete the note at <strong>{edit.path}</strong>.
                              </div>
                            )}

                            {edit.type === "merge" && (
                              <div className="proposalMergeFields">
                                <div>
                                  <strong>Target Destination:</strong> <code className="proposalPath">{edit.newPath}</code>
                                </div>
                                <div className="proposalEditor" style={{ marginTop: 8 }}>
                                  <label>Merged Content:</label>
                                  <textarea
                                    className="proposalTextarea"
                                    value={edit.content || ""}
                                    disabled={edit.applied}
                                    onChange={(e) => {
                                      setProposedEdits(prev =>
                                        prev.map(p => p.id === edit.id ? { ...p, content: e.target.value } : p)
                                      );
                                    }}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      </section>

      <aside className="contextPane">
        <section>
          <h2>LLM Context</h2>
          <div className="bundleSummary">
            <span>{selectedContextCount}/{contextCandidates.length} notes</span>
            <span>{selectedContextCharacters} chars</span>
          </div>

          <div className="budgetSection">
            <div className="budgetsHeader">
              <span>{selectedContextTokens.toLocaleString()} / {contextLimit.toLocaleString()} tokens</span>
              <span className="budgetPercent">{Math.min(100, Math.round((selectedContextTokens / contextLimit) * 100))}%</span>
            </div>
            
            <div className="progressBarOuter">
              <div 
                className={`progressBarInner ${selectedContextTokens > contextLimit ? "overLimit" : ""}`}
                style={{ width: `${Math.min(100, (selectedContextTokens / contextLimit) * 100)}%` }}
              />
            </div>

            {selectedContextTokens > contextLimit && (
              <div className="budgetWarning">
                <p style={{ margin: 0, marginBottom: "8px" }}>
                  ⚠️ Exceeded target limit by {(selectedContextTokens - contextLimit).toLocaleString()} tokens.
                </p>
                <div className="warningActions">
                  {contextCandidates.some((c) => selectedContextPaths.has(c.path) && c.reason === "Recommended") && (
                    <button className="warningButton" onClick={() => void autoPruneCandidates()}>
                      Auto-prune Recommended
                    </button>
                  )}
                  {bundleMode !== "short" && (
                    <button className="warningButton" onClick={() => void switchToShortMode()}>
                      Switch to Short Mode
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="limitConfig">
              <label htmlFor="context-limit-select">Limit</label>
              <div className="limitInputs">
                <select
                  id="context-limit-select"
                  value={isCustomLimit ? "custom" : contextLimit}
                  onChange={(event) => {
                    const val = event.target.value;
                    if (val === "custom") {
                      setIsCustomLimit(true);
                    } else {
                      setIsCustomLimit(false);
                      handleLimitChange(parseInt(val, 10));
                    }
                  }}
                >
                  <option value={8000}>Small - 8K</option>
                  <option value={32000}>Medium - 32K</option>
                  <option value={128000}>Large - 128K</option>
                  <option value={200000}>Huge - 200K</option>
                  <option value="custom">Custom...</option>
                </select>

                {isCustomLimit && (
                  <input
                    type="number"
                    className="customLimitField"
                    placeholder="Tokens..."
                    value={contextLimit}
                    onChange={(event) => {
                      const val = parseInt(event.target.value, 10);
                      handleLimitChange(isNaN(val) ? 0 : val);
                    }}
                  />
                )}
              </div>
            </div>
          </div>

          <div className="bundleOptions">
            <div className="optionGroup">
              <label htmlFor="bundle-preset">Preset</label>
              <select
                id="bundle-preset"
                value={bundlePreset}
                onChange={(event) => handlePresetChange(event.target.value)}
              >
                {Object.entries(PRESETS).map(([key, config]) => (
                  <option key={key} value={key}>
                    {config.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="optionGroup">
              <label htmlFor="bundle-purpose">Purpose</label>
              <input
                id="bundle-purpose"
                type="text"
                placeholder="e.g. Summarize or refactor..."
                value={bundlePurpose}
                onChange={(event) => {
                  const val = event.target.value;
                  const nextPreset = presetForSettings(val, bundleMode);
                  setBundlePurpose(val);
                  setBundlePreset(nextPreset);
                  void updateVaultConfig({ bundlePurpose: val, bundlePreset: nextPreset });
                  setContextBundle(null);
                }}
              />
            </div>
            <div className="optionGroup">
              <label htmlFor="bundle-mode">Mode</label>
              <select
                id="bundle-mode"
                value={bundleMode}
                onChange={(event) => {
                  const val = normalizeBundleMode(event.target.value, bundleMode);
                  const nextPreset = presetForSettings(bundlePurpose, val);
                  setBundleMode(val);
                  setBundlePreset(nextPreset);
                  void updateVaultConfig({ bundleMode: val, bundlePreset: nextPreset });
                  setContextBundle(null);
                }}
              >
                <option value="short">Short (Excerpt)</option>
                <option value="standard">Standard (Full)</option>
                <option value="full">Full (Full + Links)</option>
              </select>
            </div>
          </div>
          <div className="candidatesSectionHeader">
            <h3>
              Related Candidates ({displayedCandidates.length})
              {embeddingStatus && <span className="embeddingStatusText"> ({embeddingStatus})</span>}
            </h3>
            <div className="candidatesFilterControls">
              <div className="filterGroup">
                <label htmlFor="candidates-sort">Sort</label>
                <select
                  id="candidates-sort"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                >
                  <option value="score">Score</option>
                  <option value="title">Title</option>
                  <option value="reason">Reason</option>
                </select>
              </div>
              <div className="filterGroup">
                <label htmlFor="candidates-filter">Filter</label>
                <select
                  id="candidates-filter"
                  value={filterBy}
                  onChange={(e) => setFilterBy(e.target.value)}
                >
                  <option value="all">All</option>
                  <option value="selected">Selected</option>
                  <option value="focus">Focus</option>
                  <option value="outgoing">Outgoing</option>
                  <option value="backlink">Backlink</option>
                  <option value="recommended">Recommended</option>
                </select>
              </div>
            </div>
          </div>
          <div className="candidateList">
            {displayedCandidates.map((candidate) => {
              const scoreColorClass = 
                candidate.score >= 9.0 ? "score-high" :
                candidate.score >= 7.0 ? "score-medium" : "score-low";
              const reasonClass = `reason-badge reason-${candidate.reason.toLowerCase()}`;

              return (
                <div key={candidate.path} className="candidateRow">
                  <div className="candidateTop">
                    <label className="candidateLabel">
                      <input
                        type="checkbox"
                        checked={selectedContextPaths.has(candidate.path)}
                        onChange={() => toggleContextCandidate(candidate.path)}
                      />
                      <strong>{candidate.title}</strong>
                    </label>
                    <div className="candidateBadges">
                      <span className={reasonClass}>{candidate.reason}</span>
                      <span className={`score-badge ${scoreColorClass}`}>{candidate.score.toFixed(1)}</span>
                    </div>
                  </div>
                  <div className="candidateDetails">
                    <p className="reasonDetail">{candidate.reasonDetail}</p>
                    {candidate.excerpt && <p className="candidateExcerpt">{candidate.excerpt}</p>}
                    <span className="candidateMeta">{candidate.characterCount} chars · ~{candidate.tokenEstimate.toLocaleString()} tokens · {candidate.path}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <button onClick={() => void generateContextBundle()} disabled={!activePath || selectedContextCount === 0}>Generate bundle</button>
          {contextBundle && (
            <div className="bundleBox">
              <p className="muted">
                {contextBundle.notePaths.length} notes · {contextBundle.markdown.length} chars · ~{contextBundle.estimatedTokens.toLocaleString()} tokens
              </p>
              {contextBundle.estimatedTokens > contextLimit && (
                <div className="budgetWarning" style={{ marginBottom: "8px" }}>
                  <p style={{ margin: 0, marginBottom: "8px" }}>
                    ⚠️ Generated bundle exceeds target limit by {(contextBundle.estimatedTokens - contextLimit).toLocaleString()} tokens.
                  </p>
                  <div className="warningActions">
                    {contextCandidates.some((c) => selectedContextPaths.has(c.path) && c.reason === "Recommended") && (
                      <button className="warningButton" onClick={() => void autoPruneCandidates()}>
                        Auto-prune & Regenerate
                      </button>
                    )}
                    {bundleMode !== "short" && (
                      <button className="warningButton" onClick={() => void switchToShortMode()}>
                        Switch to Short Mode
                      </button>
                    )}
                  </div>
                </div>
              )}
              <details className="bundleAuditDetails">
                <summary>🔍 Context Bundle Audit & Diff</summary>
                <div className="bundleAuditContent">
                  {prevContextBundle && (
                    <div className="bundleDiffSection">
                      <h4>Changes from Previous Bundle</h4>
                      <div className="bundleDiffMetrics">
                        <span className={`tokenDeltaBadge ${contextBundle.estimatedTokens - prevContextBundle.estimatedTokens > 0 ? "positive" : contextBundle.estimatedTokens - prevContextBundle.estimatedTokens < 0 ? "negative" : "zero"}`}>
                          {contextBundle.estimatedTokens - prevContextBundle.estimatedTokens > 0 ? `+${(contextBundle.estimatedTokens - prevContextBundle.estimatedTokens).toLocaleString()}` : (contextBundle.estimatedTokens - prevContextBundle.estimatedTokens).toLocaleString()} tokens
                        </span>
                        {contextBundle.notePaths.filter(p => !new Set(prevContextBundle.notePaths).has(p)).length === 0 &&
                         prevContextBundle.notePaths.filter(p => !new Set(contextBundle.notePaths).has(p)).length === 0 && (
                          <span className="muted italic" style={{ marginLeft: "8px" }}>No note list changes</span>
                        )}
                      </div>
                      
                      {contextBundle.notePaths.filter(p => !new Set(prevContextBundle.notePaths).has(p)).length > 0 && (
                        <div className="diffGroup">
                          <span className="diffLabel added">Added ({contextBundle.notePaths.filter(p => !new Set(prevContextBundle.notePaths).has(p)).length}):</span>
                          <div className="diffNotesList">
                            {contextBundle.notePaths.filter(p => !new Set(prevContextBundle.notePaths).has(p)).map(p => (
                              <span key={p} className="diffNoteName added">+{p.split('/').pop() || p}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      {prevContextBundle.notePaths.filter(p => !new Set(contextBundle.notePaths).has(p)).length > 0 && (
                        <div className="diffGroup">
                          <span className="diffLabel removed">Removed ({prevContextBundle.notePaths.filter(p => !new Set(contextBundle.notePaths).has(p)).length}):</span>
                          <div className="diffNotesList">
                            {prevContextBundle.notePaths.filter(p => !new Set(contextBundle.notePaths).has(p)).map(p => (
                              <span key={p} className="diffNoteName removed">-{p.split('/').pop() || p}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="bundleBreakdownSection">
                    <h4>Included Notes Breakdown</h4>
                    <div className="auditBreakdownList">
                      {contextBundle.notePaths.map(path => {
                        const isFocus = path === activePath;
                        const cand = contextCandidates.find(c => c.path === path);
                        const title = cand?.title || path.split('/').pop() || path;
                        const reason = isFocus ? "Focus" : (cand?.reason || "Linked");
                        const reasonDetail = isFocus ? "This is the active note of your workspace." : (cand?.reasonDetail || "Referenced note");
                        
                        // Quality flags calculation
                        const characterCount = isFocus ? draft.length : (cand?.characterCount || 0);
                        const isTooLarge = characterCount > 10000 || (cand ? cand.tokenEstimate > 2500 : false);
                        
                        const noteMeta = vault?.notes.find(n => n.path === path);
                        const modifiedAtStr = noteMeta?.modifiedAt;
                        let isStale = false;
                        if (modifiedAtStr) {
                          const modifiedDate = new Date(modifiedAtStr);
                          const diffTime = Date.now() - modifiedDate.getTime();
                          const diffDays = diffTime / (1000 * 60 * 60 * 24);
                          isStale = diffDays > 30;
                        }
                        
                        const isUseful = isFocus || reason === "Outgoing" || reason === "Backlink" || (cand ? cand.score >= 7.5 : false);
                        const isRedundant = cand ? (cand.reason === "Recommended" && cand.score < 5.0) : false;
                        
                        const qualityBadges: { type: string; label: string }[] = [];
                        if (isUseful) qualityBadges.push({ type: "useful", label: "Useful" });
                        if (isRedundant) qualityBadges.push({ type: "redundant", label: "Redundant" });
                        if (isTooLarge) qualityBadges.push({ type: "large", label: "Too Large" });
                        if (isStale) qualityBadges.push({ type: "stale", label: "Stale" });
                        
                        return (
                          <div key={path} className="auditNoteRow">
                            <div className="auditNoteHeader">
                              <span className="auditNoteTitle" title={path}>{title}</span>
                              <span className={`reason-badge reason-${reason.toLowerCase()}`}>{reason}</span>
                            </div>
                            <div className="auditNoteDetail">{reasonDetail}</div>
                            {qualityBadges.length > 0 && (
                              <div className="qualityBadges">
                                {qualityBadges.map(badge => (
                                  <span key={badge.type} className={`qualityBadge ${badge.type}`}>
                                    {badge.label}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </details>

              <div className="promptWorkspace">
                <h3>Prompt Workspace</h3>
                <div className="optionGroup" style={{ marginTop: "4px" }}>
                  <div className="promptWorkspaceHeader">
                    <label htmlFor="prompt-instruction">Question / Instructions</label>
                    <div className="templateSelectorContainer">
                      <button 
                        className="smallButton" 
                        onClick={() => setShowTemplates(!showTemplates)}
                        style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
                      >
                        Templates ▾
                      </button>
                      <button 
                        className="smallButton" 
                        onClick={() => void saveAsTemplate()} 
                        disabled={!promptInstruction.trim()}
                        title="Save current instructions as template"
                      >
                        Save as Template
                      </button>

                      {showTemplates && (
                        <div className="templatesDropdownMenu">
                          <div className="templatesDropdownHeader">System Templates</div>
                          {BUILTIN_TEMPLATES.map((tmpl) => (
                            <div 
                              key={tmpl.id} 
                              className="templatesDropdownItem"
                              onClick={() => {
                                handlePromptInstructionChange(compileTemplate(tmpl.template));
                                setShowTemplates(false);
                              }}
                            >
                              <span>{tmpl.name}</span>
                            </div>
                          ))}
                          {vaultConfig.promptTemplates && vaultConfig.promptTemplates.length > 0 && (
                            <>
                              <div className="templatesDropdownHeader">Custom Templates</div>
                              {vaultConfig.promptTemplates.map((tmpl) => (
                                <div 
                                  key={tmpl.id} 
                                  className="templatesDropdownItem customTemplateItem"
                                  onClick={() => {
                                    handlePromptInstructionChange(compileTemplate(tmpl.template));
                                    setShowTemplates(false);
                                  }}
                                >
                                  <span>{tmpl.name}</span>
                                  <button 
                                    className="deleteTemplateBtn"
                                    onClick={(e) => void deleteTemplate(tmpl.id, e)}
                                    title="Delete custom template"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <textarea
                    id="prompt-instruction"
                    placeholder="Ask a question or specify the task for the LLM..."
                    value={promptInstruction}
                    onChange={(e) => handlePromptInstructionChange(e.target.value)}
                    style={{ minHeight: "80px" }}
                  />
                </div>
                <div className="workspaceActions">
                  <button className="primary" onClick={() => void copyCombinedPrompt()}>
                    Copy Final Prompt
                  </button>
                  <button onClick={() => void copyContextBundle()}>
                    Copy Bundle Only
                  </button>
                </div>
              </div>
              <textarea readOnly value={contextBundle.markdown} />
            </div>
          )}
        </section>
        <section className="promptHistorySection">
          <h2>Prompt History</h2>
          {(!vaultConfig.promptRuns || vaultConfig.promptRuns.length === 0) ? (
            <p className="muted">No history yet</p>
          ) : (() => {
            const filteredPromptRuns = (vaultConfig.promptRuns ?? []).filter(run => {
              if (historySearchQuery.trim()) {
                const q = historySearchQuery.toLowerCase();
                const matchQuestion = run.question.toLowerCase().includes(q);
                const matchPreset = run.preset.toLowerCase().includes(q);
                const matchNote = run.activePath.toLowerCase().includes(q);
                if (!matchQuestion && !matchPreset && !matchNote) {
                  return false;
                }
              }
              if (historyActiveNoteOnly && activePath && run.activePath !== activePath) {
                return false;
              }
              if (historyPresetFilter && run.preset !== historyPresetFilter) {
                return false;
              }
              return true;
            });

            return (
              <>
                {archiveStatus && (
                  <div className="archiveStatusBar">
                    <span className="archiveStatusText">
                      📁 Archive: <strong>{archiveStatus.fileCount}</strong> file(s) ({(archiveStatus.totalBytes / 1024).toFixed(1)} KB)
                    </span>
                    <div className="archiveActions">
                      <button
                        className="smallButton exportButton"
                        onClick={() => void exportPromptRuns()}
                        title="Export prompt runs as a JSON file"
                      >
                        Export
                      </button>
                      <button
                        className="smallButton importButton"
                        onClick={() => window.document.getElementById("promptArchiveImportInput")?.click()}
                        title="Import prompt runs from a JSON file"
                      >
                        Import
                      </button>
                      <input
                        id="promptArchiveImportInput"
                        type="file"
                        accept=".json"
                        style={{ display: "none" }}
                        onChange={(e) => void handleImportArchiveFile(e)}
                      />
                      <button
                        className="smallButton pruneButton"
                        onClick={() => void pruneArchivedPrompts()}
                        title="Clean up disk files of deleted prompt runs"
                      >
                        Prune Orphaned
                      </button>
                    </div>
                  </div>
                )}
                <div className="historyFilters">
                  <input
                    type="text"
                    placeholder="Search history..."
                    value={historySearchQuery}
                    onChange={(e) => setHistorySearchQuery(e.target.value)}
                    className="historySearchField"
                  />
                  <div className="historyFilterControls">
                    <label className="historyFilterCheckbox">
                      <input
                        type="checkbox"
                        checked={historyActiveNoteOnly}
                        onChange={(e) => setHistoryActiveNoteOnly(e.target.checked)}
                      />
                      <span>Active note only</span>
                    </label>
                    <select
                      value={historyPresetFilter}
                      onChange={(e) => setHistoryPresetFilter(e.target.value)}
                      className="historyPresetSelect"
                    >
                      <option value="">All presets</option>
                      {Array.from(new Set((vaultConfig.promptRuns ?? []).map((r) => r.preset))).map((preset) => (
                        <option key={preset} value={preset}>{preset}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {filteredPromptRuns.length === 0 ? (
                  <p className="muted">No matching history found</p>
                ) : (
                  <div className="promptRunList">
                    {filteredPromptRuns.map((run) => (
                      <div 
                        key={run.id} 
                        className={`promptRunCard ${expandedRunId === run.id ? "expanded" : ""}`}
                        style={{ cursor: "pointer" }}
                        onClick={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
                      >
                        <div className="promptRunHeader">
                          <span className="promptRunTime" title={run.createdAt}>
                            {new Date(run.createdAt).toLocaleString()}
                          </span>
                          <span className="promptRunMetaBadge">{run.preset} / {run.mode}</span>
                        </div>
                        <div className="promptRunQuestion">
                          {run.question ? run.question : <span className="muted italic">No question (bundle only)</span>}
                        </div>
                        <div className="promptRunDetails">
                          <span className="promptRunNoteLink" title="Click to view note" onClick={(e) => { e.stopPropagation(); void selectNote(run.activePath); }}>
                            [[{run.activePath.split('/').pop() || run.activePath}]]
                          </span>
                          <span className="promptRunTokens">{run.tokenCount.toLocaleString()} tokens</span>
                        </div>
                        <div className="promptRunActions" onClick={(e) => e.stopPropagation()}>
                          <button className="smallButton" onClick={() => void applyPromptRun(run)}>
                            Load
                          </button>
                          <button className="smallButton" onClick={() => void copyPromptRunQuestion(run)}>
                            Copy Question
                          </button>
                          <button className="smallButton" onClick={() => void copyFullPromptFromHistory(run)}>
                            Copy Full Prompt
                          </button>
                          <button className="smallButton dangerButton" onClick={(e) => void deletePromptRun(run.id, e)}>
                            Delete
                          </button>
                        </div>
                        {expandedRunId === run.id && (
                          <div className="promptRunExpandedPanel" onClick={(e) => e.stopPropagation()}>
                            {run.promptHash && (
                              <div className="expandedMetaRow">
                                <strong>Hash:</strong> <code>{run.promptHash}</code>
                              </div>
                            )}
                            <div className="expandedMetaRow">
                              <strong>Included Notes ({run.selectedNotes.length}):</strong>
                              <div className="expandedNotesList">
                                {run.selectedNotes.map(p => (
                                  <span key={p} className="expandedNoteBadge">{p.split('/').pop() || p}</span>
                                ))}
                              </div>
                            </div>
                            {run.preview && (
                              <div className="expandedPreviewWrapper">
                                <strong>Prompt Preview (First 1.5 KB):</strong>
                                <textarea readOnly value={run.preview} className="expandedPreviewTextarea" />
                              </div>
                            )}
                            {contextBundle ? (() => {
                              const currentCombined = buildCombinedPrompt(promptInstruction, contextBundle.markdown);
                              const currentHash = currentPromptHash ?? "calculating";
                              const hashesMatch = Boolean(currentPromptHash && run.promptHash && currentPromptHash === run.promptHash);
                              
                              const addedNotes = contextBundle.notePaths.filter(p => !new Set(run.selectedNotes).has(p));
                              const removedNotes = run.selectedNotes.filter(p => !new Set(contextBundle.notePaths).has(p));
                              
                              const instructionDiffers = promptInstruction.trim() !== run.question.trim();
                              
                              return (
                                <div className="historyDiffContainer">
                                  <div className="diffHeader">
                                    <strong>🔍 Session Comparison</strong>
                                    {hashesMatch ? (
                                      <span className="diffStatusBadge match">🟢 Exact Match</span>
                                    ) : (
                                      <span className="diffStatusBadge modified">🟡 Modified</span>
                                    )}
                                  </div>
                                  
                                  {!hashesMatch && (
                                    <div className="diffDetails">
                                      <div className="diffRow">
                                        <span className="diffLabel">Prompt Hash:</span>
                                        <div className="diffValue">
                                          <span className="hashStored">{run.promptHash || "none"}</span>
                                          <span className="hashArrow">➔</span>
                                          <span className="hashCurrent">{currentHash}</span>
                                        </div>
                                      </div>

                                      {instructionDiffers && (
                                        <div className="diffRow instructionDiff">
                                          <span className="diffLabel">Instruction Text:</span>
                                          <div className="diffValueText">
                                            <div className="diffTextRemoved">- {run.question || "(empty)"}</div>
                                            <div className="diffTextAdded">+ {promptInstruction || "(empty)"}</div>
                                          </div>
                                        </div>
                                      )}

                                      {(addedNotes.length > 0 || removedNotes.length > 0) && (
                                        <div className="diffRow notesDiff">
                                          <span className="diffLabel">Notes Changes:</span>
                                          <div className="diffNotesDelta">
                                            {removedNotes.map(n => (
                                              <span key={n} className="diffNoteBadge removed">-{n.split('/').pop() || n}</span>
                                            ))}
                                            {addedNotes.map(n => (
                                              <span key={n} className="diffNoteBadge added">+{n.split('/').pop() || n}</span>
                                            ))}
                                          </div>
                                        </div>
                                      )}

                                      {run.preview && (
                                        <div className="diffRow previewDiff">
                                          <span className="diffLabel">Preview Comparison (Stored vs Current):</span>
                                          <div className="diffPreviewsSplit">
                                            <div className="diffPreviewBox stored">
                                              <div className="boxTitle">Stored Run</div>
                                              <pre>{run.preview}</pre>
                                            </div>
                                            <div className="diffPreviewBox current">
                                              <div className="boxTitle">Current Session</div>
                                              <pre>{currentCombined.slice(0, 1500) + (currentCombined.length > 1500 ? "..." : "")}</pre>
                                            </div>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                  
                                  <div className="diffFullTextCompareSection">
                                    <button
                                      className="smallButton secondary"
                                      onClick={() => void loadPromptDiff(run)}
                                      style={{ marginTop: "8px" }}
                                    >
                                      {diffRunId === run.id ? "Hide Full Text Diff" : "Compare Full Text (Exact)"}
                                    </button>

                                    {diffRunId === run.id && diffResult && (
                                      <div className="fullPromptDiffWrapper">
                                        <div className="diffHeader">
                                          <strong>Unified Prompt Diff</strong>
                                          {diffResult.regenerating && <span className="diffRegenText">Retrieving/Regenerating...</span>}
                                        </div>
                                        {diffResult.error ? (
                                          <div className="diffErrorText">{diffResult.error}</div>
                                        ) : (
                                          <div className="fullPromptDiffBox">
                                            {diffResult.lines.map((line, idx) => (
                                              <div key={idx} className={`diffLine ${line.type}`}>
                                                <span className="diffPrefix">
                                                  {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                                                </span>
                                                <span className="diffContent">{line.value}</span>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })() : (
                              <div className="historyDiffContainer muted italic">
                                Generate a bundle in the current workspace to compare with this historical run.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </section>
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
          <h2>Backlinks</h2>
          {context?.backlinks.length ? context.backlinks.map((link) => (
            <button key={`${link.sourcePath}-${link.line}`} onClick={() => void selectNote(link.sourcePath)}>
              {link.sourcePath}
            </button>
          )) : <p className="muted">No backlinks</p>}
        </section>
        <section>
          <h2>Outgoing</h2>
          {context?.outgoingLinks.map((link) => (
            <button key={`${link.targetRef}-${link.line}`} disabled={!link.resolvedPath} onClick={() => link.resolvedPath && void selectNote(link.resolvedPath)}>
              {link.targetRef}{link.isManaged ? " · managed" : ""}
            </button>
          ))}
        </section>
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

function SearchPanel(props: {
  query: string;
  tagFilter: string;
  propertyFilter: string;
  tags: string[];
  searchMode: "keyword" | "semantic";
  onSearchModeChange(mode: "keyword" | "semantic"): void;
  onSubmit(): void;
  onQuery(value: string): void;
  onTag(value: string): void;
  onProperty(value: string): void;
}) {
  return (
    <section className="searchPanel">
      <div className="searchModeToggle">
        <button
          type="button"
          className={props.searchMode === "keyword" ? "active" : ""}
          onClick={() => props.onSearchModeChange("keyword")}
        >
          Keyword
        </button>
        <button
          type="button"
          className={props.searchMode === "semantic" ? "active" : ""}
          onClick={() => props.onSearchModeChange("semantic")}
        >
          Semantic
        </button>
      </div>
      <div className="searchInputContainer">
        <input
          value={props.query}
          onChange={(event) => props.onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              props.onSubmit();
            }
          }}
          placeholder={props.searchMode === "semantic" ? "Semantic query (Enter)..." : "Search notes"}
        />
        {props.searchMode === "semantic" && (
          <button type="button" onClick={props.onSubmit} className="btnSemanticSearch">
            Go
          </button>
        )}
      </div>
      {props.searchMode === "keyword" && (
        <>
          <select value={props.tagFilter} onChange={(event) => props.onTag(event.target.value)}>
            <option value="">All tags</option>
            {props.tags.map((tag) => <option key={tag} value={tag}>#{tag}</option>)}
          </select>
          <input value={props.propertyFilter} onChange={(event) => props.onProperty(event.target.value)} placeholder="status=draft" />
        </>
      )}
    </section>
  );
}

function TreeNode({
  node,
  activePath,
  onSelect,
  onRename,
  onDelete
}: {
  node: FileTreeNode;
  activePath: string | null;
  onSelect(path: string): void;
  onRename(path: string): void;
  onDelete(path: string, kind: FileTreeNode["kind"]): void;
}) {
  const actions = (
    <span className="treeActions">
      <button title={`Rename ${node.name}`} onClick={(event) => {
        event.stopPropagation();
        onRename(node.path);
      }}>Rename</button>
      <button title={`Delete ${node.name}`} onClick={(event) => {
        event.stopPropagation();
        onDelete(node.path, node.kind);
      }}>Delete</button>
    </span>
  );

  if (node.kind === "note") {
    return (
      <div className={node.path === activePath ? "treeRow active" : "treeRow"}>
        <button className="treeItem" onClick={() => onSelect(node.path)}>{node.name}</button>
        {actions}
      </div>
    );
  }

  return (
    <details open>
      <summary>
        <span>{node.name}</span>
        {actions}
      </summary>
      <div className="treeChildren">
        {node.children.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            activePath={activePath}
            onSelect={onSelect}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
      </div>
    </details>
  );
}

function GraphView(props: {
  graph: GraphData;
  activePath: string | null;
  onOpen(path: string): void;
  onCreateLink(path: string): void;
  onDeleteLink(path: string): void;
}) {
  const nodes = useMemo<Node[]>(
    () =>
      props.graph.nodes.map((node, index) => ({
        id: node.id,
        position: { x: 80 + (index % 3) * 220, y: 80 + Math.floor(index / 3) * 160 },
        data: { label: node.label },
        className: node.id === props.activePath ? "graphNode active" : "graphNode"
      })),
    [props.graph.nodes, props.activePath]
  );
  const edges = useMemo<Edge[]>(
    () => props.graph.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, animated: edge.isManaged })),
    [props.graph.edges]
  );

  const onNodeClick = useCallback((_: unknown, node: Node) => props.onOpen(node.id), [props]);
  const otherNodes = props.graph.nodes.filter((node) => node.id !== props.activePath);

  return (
    <div className="graphShell">
      <div className="graphToolbar">
        <select onChange={(event) => event.target.value && props.onCreateLink(event.target.value)} defaultValue="">
          <option value="">Add link from current note</option>
          {otherNodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
        </select>
        <select onChange={(event) => event.target.value && props.onDeleteLink(event.target.value)} defaultValue="">
          <option value="">Remove managed link</option>
          {otherNodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
        </select>
      </div>
      <ReactFlow nodes={nodes} edges={edges} onNodeClick={onNodeClick} fitView>
        <Background />
        <MiniMap />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function parsePropertyFilter(value: string): Record<string, string> {
  if (!value.includes("=")) {
    return {};
  }
  const [key, ...rest] = value.split("=");
  return key.trim() ? { [key.trim()]: rest.join("=").trim() } : {};
}

function currentFolderPath(activePath: string | null): string | null {
  if (!activePath) {
    return null;
  }
  const index = activePath.lastIndexOf("/");
  return index === -1 ? null : activePath.slice(0, index);
}

function isInboxPath(path: string): boolean {
  return /^Inbox\/.+\.md$/i.test(path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
