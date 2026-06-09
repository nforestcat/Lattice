import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { vaultApi } from "../api";
import { askConfirm, isDesktopRuntime, pickVaultFolder } from "../api/dialog";
import type { ContextBundle, ContextBundleCandidate, FileTreeNode, GitStatus, NoteDocument, Snapshot, VaultSnapshot, VaultConfig, PromptRun, PromptTemplate, ProposedEdit, LlmConfig, LlmProvider, BacklinkSuggestion, NoteTemplate, NoteHealthReport, StubDraftReview, GitFileChange } from "../api/types";
import { sendChatMessage, type ChatMessage } from "../api/llm";
import { getEmbedding, cosineSimilarity, type VectorCache } from "../api/embeddings";
import type { InboxCaptureBlock } from "../core/capture";
import type { GraphData, NoteContext, NoteMeta } from "../core/types";
import { estimateTokens } from "../core/contextBundle";
import { renderMarkdownPreview } from "./markdownPreview";
import { getStartupVaultPath, rememberVaultPath } from "./vaultStartup";
import { GraphView } from "./components/GraphView";
import { PromptHistoryPanel } from "./components/PromptHistoryPanel";
import { DistillWorkspace } from "./components/DistillWorkspace";
import { Sidebar } from "./components/Sidebar";
import { InspectorPanel } from "./components/InspectorPanel";
import { EditorToolbar } from "./components/EditorToolbar";

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
const DEFAULT_LLM_CONFIG: LlmConfig = { provider: "openai", apiKey: "", model: "gpt-4o" };

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

function redactLlmConfig(config: LlmConfig): LlmConfig {
  return { ...config, apiKey: "" };
}

function hydrateLlmConfigSecrets(config: LlmConfig): LlmConfig {
  return { ...config, apiKey: readStoredLlmApiKey(config.provider) || config.apiKey || "" };
}

function sanitizeVaultConfig(config: VaultConfig): VaultConfig {
  return {
    ...config,
    llmConfig: config.llmConfig ? redactLlmConfig(config.llmConfig) : config.llmConfig
  };
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

function normalizeLlmConfig(value: any): LlmConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return {
    provider: typeof value.provider === "string" && ["openai", "anthropic", "gemini", "ollama", "custom", "lm-studio"].includes(value.provider) ? value.provider as LlmProvider : "openai",
    apiKey: "",
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
  const [embeddingsCache, setEmbeddingsCache] = useState<VectorCache>({});
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
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_LLM_CONFIG);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [distillTab, setDistillTab] = useState<"paste" | "chat" | "auditor" | "git">("paste");
  const [gitChanges, setGitChanges] = useState<GitFileChange[]>([]);
  const [selectedGitFile, setSelectedGitFile] = useState<string | null>(null);
  const [selectedGitFileStaged, setSelectedGitFileStaged] = useState<boolean>(false);
  const [activeDiff, setActiveDiff] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState<string>("");
  const [isGitLoading, setIsGitLoading] = useState<boolean>(false);
  const [gitOutputLog, setGitOutputLog] = useState<string | null>(null);
  const [auditorSubTab, setAuditorSubTab] = useState<"health" | "links">("health");
  const [activeUnresolvedTarget, setActiveUnresolvedTarget] = useState<string | null>(null);
  const [isLlmGenerating, setIsLlmGenerating] = useState(false);
  const [includeContext, setIncludeContext] = useState(true);
  const [showLlmSettings, setShowLlmSettings] = useState(false);
  const [linkSuggestions, setLinkSuggestions] = useState<{ text: string; path: string }[]>([]);
  const [embeddingStatus, setEmbeddingStatus] = useState("");
  const [unresolvedLinks, setUnresolvedLinks] = useState<{ target: string; sources: { path: string; title: string; excerpt: string }[] }[]>([]);
  const [isScanningUnresolved, setIsScanningUnresolved] = useState(false);
  const [draftingTarget, setDraftingTarget] = useState<string | null>(null);
  const [draftedContent, setDraftedContent] = useState<string | null>(null);
  const [isDraftingStub, setIsDraftingStub] = useState(false);
  const [selectedUnresolvedTargets, setSelectedUnresolvedTargets] = useState<Set<string>>(new Set());
  const [bulkDrafts, setBulkDrafts] = useState<Record<string, StubDraftReview>>({});
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);

  const [backlinkSuggestions, setBacklinkSuggestions] = useState<BacklinkSuggestion[]>([]);
  const [isLoadingBacklinkSuggestions, setIsLoadingBacklinkSuggestions] = useState(false);

  const [healthReports, setHealthReports] = useState<NoteHealthReport[]>([]);
  const [isScanningHealth, setIsScanningHealth] = useState(false);

  async function runHealthAudit() {
    setIsScanningHealth(true);
    try {
      const reports = await vaultApi.getWikiHealthReport();
      reports.sort((a, b) => a.score - b.score);
      setHealthReports(reports);
    } catch (e) {
      console.error("Failed to run background health audit", e);
    } finally {
      setIsScanningHealth(false);
    }
  }

  const globalHealthScore = useMemo(() => {
    if (isScanningHealth && healthReports.length === 0) {
      return null;
    }
    if (!vault || vault.notes.length === 0) {
      return 100;
    }
    if (healthReports.length === 0) {
      return null;
    }
    const total = healthReports.reduce((sum, r) => sum + r.score, 0);
    return Math.round(total / healthReports.length);
  }, [healthReports, isScanningHealth, vault]);

  async function refreshBacklinkSuggestions(path: string) {
    setIsLoadingBacklinkSuggestions(true);
    try {
      const suggestions = await vaultApi.getBacklinkSuggestions(path);
      setBacklinkSuggestions(suggestions);
    } catch (e) {
      console.error("Failed to fetch backlink suggestions", e);
    } finally {
      setIsLoadingBacklinkSuggestions(false);
    }
  }

  async function applyBacklinkSuggestion(suggestion: BacklinkSuggestion) {
    setStatus(`Applying backlink suggestion from ${suggestion.sourceTitle}...`);
    try {
      await vaultApi.applyBacklinkSuggestion(suggestion);
      setStatus(`Applied backlink suggestion!`);
      if (vault) {
        const nextVault = await vaultApi.openVault(vault.rootPath);
        setVault(nextVault);
      }
      if (activePath) {
        await refreshContext(activePath);
        await refreshBacklinkSuggestions(activePath);
      }
      void runHealthAudit();
    } catch (e) {
      console.error("Failed to apply backlink suggestion", e);
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const [metadataSuggestions, setMetadataSuggestions] = useState<{ tags: string[]; frontmatter: Record<string, string> } | null>(null);
  const [selectedSuggestedTags, setSelectedSuggestedTags] = useState<Set<string>>(new Set());
  const [selectedSuggestedProperties, setSelectedSuggestedProperties] = useState<Set<string>>(new Set());
  const [isGeneratingMetadata, setIsGeneratingMetadata] = useState(false);

  async function generateMetadataSuggestions() {
    if (!activePath || !document) return;
    const config = llmConfig;
    if (!config.provider || (!config.apiKey && config.provider !== "ollama" && config.provider !== "lm-studio")) {
      setStatus("Please configure LLM settings first");
      return;
    }

    setIsGeneratingMetadata(true);
    setStatus("Generating metadata suggestions...");
    try {
      const prompt = `Analyze this note and suggest metadata (tags and YAML frontmatter key-value pairs).
Return the result STRICTLY as a JSON object with this structure:
{
  "tags": ["tag1", "tag2"],
  "frontmatter": {
    "status": "draft",
    "area": "product",
    "summary": "Brief summary..."
  }
}
Do not return any other text, markdown formatting, or explanation. Only return the raw JSON object.

Existing tags in the vault: ${allTags.join(", ")} (prefer using existing tags if they fit, but suggest new ones if appropriate)

Note title: ${document.path.replace(/\.md$/i, "")}
Note content:
${draft}
`;

      const response = await sendChatMessage(config, [
        { role: "system", content: "You are a metadata assistant. You only respond with JSON." },
        { role: "user", content: prompt }
      ]);

      const cleanResponse = response.replace(/```json/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleanResponse);

      const tags = Array.isArray(parsed.tags) ? parsed.tags.map((t: any) => String(t).replace(/^#/, "").trim()) : [];
      const frontmatter: Record<string, string> = {};
      if (parsed.frontmatter && typeof parsed.frontmatter === "object") {
        for (const [k, v] of Object.entries(parsed.frontmatter)) {
          frontmatter[k] = String(v);
        }
      }

      setMetadataSuggestions({ tags, frontmatter });
      setSelectedSuggestedTags(new Set(tags));
      setSelectedSuggestedProperties(new Set(Object.keys(frontmatter)));
      setStatus("Generated suggestions!");
    } catch (e) {
      console.error("Failed to generate metadata suggestions", e);
      setStatus(`Failed to generate suggestions: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsGeneratingMetadata(false);
    }
  }

  function handleToggleSuggestedTag(tag: string) {
    setSelectedSuggestedTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }

  function handleToggleSuggestedProperty(key: string) {
    setSelectedSuggestedProperties(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  async function applyMetadataSuggestions() {
    if (!activePath || !document || !metadataSuggestions) return;
    setStatus("Applying metadata...");
    try {
      const tagsToApply = Array.from(selectedSuggestedTags);
      const propertiesToApply: Record<string, string> = {};
      for (const key of Array.from(selectedSuggestedProperties)) {
        propertiesToApply[key] = metadataSuggestions.frontmatter[key];
      }

      await vaultApi.applyNoteMetadata(activePath, propertiesToApply, tagsToApply);
      
      setStatus("Applied metadata successfully!");
      setMetadataSuggestions(null);

      if (vault) {
        const nextVault = await vaultApi.openVault(vault.rootPath);
        setVault(nextVault);
      }
      await selectNote(activePath);
      void runHealthAudit();
    } catch (e) {
      console.error("Failed to apply metadata suggestions", e);
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const [isAutofillingTemplate, setIsAutofillingTemplate] = useState(false);

  async function autofillActiveNoteWithTemplate(templateName: string) {
    if (!activePath || !document) return;
    const config = llmConfig;
    if (!config.provider || (!config.apiKey && config.provider !== "ollama" && config.provider !== "lm-studio")) {
      setStatus("Please configure LLM settings first");
      return;
    }

    const template = (vaultConfig.noteTemplates || DEFAULT_NOTE_TEMPLATES).find(t => t.name === templateName);
    if (!template) return;

    setIsAutofillingTemplate(true);
    setStatus(`Applying template "${templateName}" with LLM...`);
    try {
      const prompt = `You are a note template assistant. 
Generate note content for a note titled "${document.path.replace(/\.md$/i, "")}" based on the following template instructions:
Template Name: ${template.name}
Template Guidelines: ${template.prompt}

Current note content (if any, use it as context to preserve existing information or draft a new note from scratch if empty):
${draft}

Return the complete note content including any YAML frontmatter block at the very top (bounded by ---). Return ONLY the raw markdown content. Do not include markdown code block formatting (like \`\`\`markdown) around your response.`;

      const response = await sendChatMessage(config, [
        { role: "system", content: "You only output raw markdown note content. Do not explain." },
        { role: "user", content: prompt }
      ]);

      const cleanResponse = response.replace(/^```markdown\n?/i, "").replace(/```$/g, "").trim();
      setDraft(cleanResponse);
      setStatus(`Applied template "${templateName}"!`);
    } catch (e) {
      console.error("Failed to apply template", e);
      setStatus(`Failed to apply template: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsAutofillingTemplate(false);
    }
  }

  const updateVaultConfig = async (updates: Partial<VaultConfig>) => {
    const nextConfig: VaultConfig = sanitizeVaultConfig({
      version: VAULT_CONFIG_VERSION,
      ...vaultConfigRef.current,
      ...updates
    });
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
    setActivePath(null);
    setDocument(null);
    setDraft("");
    setContext(null);
    setContextCandidates([]);
    setSelectedContextPaths(new Set());
    setInboxCaptures([]);
    setStatus(`Opened ${nextVault.rootPath}`);

    let loadedConfig: VaultConfig = {};
    let runtimeLlmConfig: LlmConfig = DEFAULT_LLM_CONFIG;
    try {
      const rawConfig = await vaultApi.getVaultConfig();
      loadedConfig = normalizeVaultConfig(rawConfig);
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
      setActivePath(null);
      setDocument(null);
      setDraft("");
      setContext(null);
      setContextCandidates([]);
      setSelectedContextPaths(new Set());
      setInboxCaptures([]);
    }
    void refreshArchiveStatus();
    void runHealthAudit();
  }

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

      const edits = await vaultApi.parseProposedEdits(response);
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
    if (!config.provider || (!config.apiKey && config.provider !== "ollama" && config.provider !== "lm-studio")) {
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
      const notesToProcess = notes;
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
      setEmbeddingsCache(cache);

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

    const config = llmConfig;
    if (!config.provider || (!config.apiKey && config.provider !== "ollama" && config.provider !== "lm-studio")) {
      setSemanticSearchError("Please configure LLM API key / Ollama / LM Studio in the Distill Settings first.");
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
      setEmbeddingsCache(cache);

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
      void runHealthAudit();
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
      void runHealthAudit();
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
      void runHealthAudit();
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

      const updated = sanitizeVaultConfig({
        ...currentConfig,
        promptRuns: nextRuns
      });

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

  async function runUnresolvedLinksScan() {
    setIsScanningUnresolved(true);
    setUnresolvedLinks([]);
    setDraftingTarget(null);
    setDraftedContent(null);
    try {
      const list = await vaultApi.getUnresolvedLinks();
      setUnresolvedLinks(list);
      setStatus(`Scan complete: found ${list.length} unresolved link(s)`);
      return list;
    } catch (err) {
      console.error(err);
      setStatus("Failed to scan unresolved links");
      return [];
    } finally {
      setIsScanningUnresolved(false);
    }
  }

  async function draftStubNote(targetTitle: string, sources: { path: string; title: string; excerpt: string }[]) {
    const config = llmConfig;
    if (!config.provider || (!config.apiKey && config.provider !== "ollama" && config.provider !== "lm-studio")) {
      setStatus("Please configure LLM settings first");
      return;
    }

    setBulkDrafts(prev => ({
      ...prev,
      [targetTitle]: { content: "", status: "drafting", approved: true }
    }));
    setSelectedUnresolvedTargets(prev => {
      const next = new Set(prev);
      next.add(targetTitle);
      return next;
    });

    try {
      const sourceInfo = sources.map(s => `Note: "${s.title}"\nContext Excerpt:\n${s.excerpt}`).join("\n\n");
      const systemPrompt = "You are an expert wiki editor. Please write a short, concise, and high-quality stub note (in Markdown) defining the term. Do not include a heading for the title, just write the body text with appropriate formatting.";
      const userPrompt = `We have an unresolved wiki link to the note "${targetTitle}". It is referenced in the following contexts:\n\n${sourceInfo}\n\nPlease write a concise defining stub note (in Markdown) for "${targetTitle}" based on this context.`;
      
      const payload: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ];

      const response = await sendChatMessage(config, payload);
      setBulkDrafts(prev => ({
        ...prev,
        [targetTitle]: { content: response, status: "done", approved: true }
      }));
      setStatus(`Drafted AI stub for "${targetTitle}"`);
    } catch (err) {
      console.error(err);
      setBulkDrafts(prev => ({
        ...prev,
        [targetTitle]: { content: "", status: "error", approved: false }
      }));
      setStatus("Failed to draft AI stub");
    }
  }

  async function createStubNote(targetTitle: string, content: string) {
    setStatus("Creating note...");
    try {
      const result = await vaultApi.createNote(null, targetTitle);
      const newPath = result.selectedPath;
      if (!newPath) {
        throw new Error("Failed to get selected path for new note");
      }

      const saveResult = await vaultApi.saveNote(newPath, content, "");
      if (saveResult.saved) {
        setStatus(`Created stub note: "${targetTitle}"`);
        await refreshVault(newPath);
        void runUnresolvedLinksScan();
      } else {
        throw new Error("Failed to save stub content");
      }
    } catch (err) {
      console.error(err);
      setStatus(`Failed to create stub note: ${errorMessage(err)}`);
    }
  }

  async function runBulkDrafting() {
    // Preserve approved drafts so user edits are not overwritten, but allow rejected drafts to be regenerated.
    const targets = Array.from(selectedUnresolvedTargets).filter(t => {
      const draft = bulkDrafts[t];
      return !(draft?.status === "done" && draft.approved);
    });
    if (targets.length === 0) {
      setStatus("No new stubs to draft");
      return;
    }

    setIsBulkProcessing(true);
    setStatus(`Bulk drafting ${targets.length} stub(s)...`);

    const nextDrafts = { ...bulkDrafts };
    for (const t of targets) {
      nextDrafts[t] = { content: "", status: "drafting", approved: true };
    }
    setBulkDrafts(nextDrafts);

    const config = llmConfig;

    for (const target of targets) {
      const item = unresolvedLinks.find(x => x.target === target);
      if (!item) continue;

      try {
        const sourceInfo = item.sources.map(s => `Note: "${s.title}"\nContext Excerpt:\n${s.excerpt}`).join("\n\n");
        const systemPrompt = "You are an expert wiki editor. Please write a short, concise, and high-quality stub note (in Markdown) defining the term. Do not include a heading for the title, just write the body text with appropriate formatting.";
        const userPrompt = `We have an unresolved wiki link to the note "${target}". It is referenced in the following contexts:\n\n${sourceInfo}\n\nPlease write a concise defining stub note (in Markdown) for "${target}" based on this context.`;
        
        const payload: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ];

        const response = await sendChatMessage(config, payload);
        setBulkDrafts(prev => ({
          ...prev,
          [target]: { content: response, status: "done", approved: true }
        }));
      } catch (err) {
        console.error(err);
        setBulkDrafts(prev => ({
          ...prev,
          [target]: { content: "", status: "error", approved: false }
        }));
      }
    }

    setIsBulkProcessing(false);
    setStatus("Finished bulk drafting stubs");
  }

  async function createSelectedStubs() {
    const targets = Array.from(selectedUnresolvedTargets).filter(t => {
      const draft = bulkDrafts[t];
      return draft?.status === "done" && draft?.approved;
    });
    if (targets.length === 0) return;

    setStatus(`Creating ${targets.length} note(s)...`);
    let successCount = 0;
    const createdTargets: string[] = [];
    try {
      for (const target of targets) {
        const draft = bulkDrafts[target];
        if (!draft || draft.status !== "done" || !draft.approved) continue;

        try {
          const result = await vaultApi.createNote(null, target);
          const newPath = result.selectedPath;
          if (newPath) {
            const saveResult = await vaultApi.saveNote(newPath, draft.content, "");
            if (!saveResult.saved) {
              throw new Error("Failed to save stub content");
            }
            successCount++;
            createdTargets.push(target);
            
            // Clear activeUnresolvedTarget if this created note was the active ghost
            if (activeUnresolvedTarget && normalizeRef(target) === activeUnresolvedTarget) {
              setActiveUnresolvedTarget(null);
            }
          }
        } catch (err) {
          console.error(`Failed to create stub for ${target}:`, err);
        }
      }

      setStatus(`Successfully created ${successCount} stub note(s).`);
      
      // Keep rejected/unprocessed targets in selection, remove successfully created ones
      const remainingTargets = new Set(selectedUnresolvedTargets);
      createdTargets.forEach(t => remainingTargets.delete(t));
      setSelectedUnresolvedTargets(remainingTargets);
      
      // Clean up successfully created drafts
      const remainingDrafts = { ...bulkDrafts };
      createdTargets.forEach(t => delete remainingDrafts[t]);
      setBulkDrafts(remainingDrafts);
      
      if (vault) {
        await refreshVault(activePath);
      }
      void runUnresolvedLinksScan();
    } catch (err) {
      console.error(err);
      setStatus("Failed to create selected stub notes");
    }
  }

  function handleSelectAllToggle() {
    if (selectedUnresolvedTargets.size === unresolvedLinks.length) {
      setSelectedUnresolvedTargets(new Set());
    } else {
      setSelectedUnresolvedTargets(new Set(unresolvedLinks.map(item => item.target)));
    }
  }

  function approveDraft(target: string) {
    setBulkDrafts(prev => prev[target] ? {
      ...prev,
      [target]: { ...prev[target], approved: true }
    } : prev);
  }

  function rejectDraft(target: string) {
    setBulkDrafts(prev => prev[target] ? {
      ...prev,
      [target]: { ...prev[target], approved: false }
    } : prev);
  }

  function approveAllDrafts() {
    setBulkDrafts(prev => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (next[k].status === "done") {
          next[k] = { ...next[k], approved: true };
        }
      }
      return next;
    });
  }

  function rejectAllDrafts() {
    setBulkDrafts(prev => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (next[k].status === "done") {
          next[k] = { ...next[k], approved: false };
        }
      }
      return next;
    });
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

  const isActiveNoteConflicted = activePath && (
    gitChanges.some(c => c.path === activePath && c.status === "conflict") ||
    (viewMode !== "distill" && viewMode !== "graph" && draft.includes("<<<<<<<") && draft.includes("=======") && draft.includes(">>>>>>>"))
  );

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
                  value={draft}
                  height="100%"
                  extensions={[markdown()]}
                  theme="light"
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
                className={`preview previewSurface ${vault?.obsidianSettings?.readableLineLength ? "previewReadable" : ""} ${
                  vault?.obsidianSettings?.theme === "obsidian" || vault?.obsidianSettings?.theme === "dark" ? "theme-dark" : ""
                }`}
                style={{ flex: 1, overflow: 'auto' }}
                dangerouslySetInnerHTML={html}
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
            />
          )}
        </div>
      </section>

      <aside className="contextPane">
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
          <h2>Backlinks</h2>
          {context?.backlinks.length ? context.backlinks.map((link) => (
            <button key={`${link.sourcePath}-${link.line}`} onClick={() => void selectNote(link.sourcePath)}>
              {link.sourcePath}
            </button>
          )) : <p className="muted">No backlinks</p>}
        </section>
        <section className="backlinkSuggestionsSection">
          <h2>AI Link Suggestions</h2>
          {isLoadingBacklinkSuggestions ? (
            <p className="loading">Scanning suggestions...</p>
          ) : backlinkSuggestions.length ? (
            <div className="backlinkSuggestionsList">
              {backlinkSuggestions.map((suggestion) => (
                <div key={suggestion.id} className="backlinkSuggestionCard">
                  <div className="suggestionHeader">
                    {suggestion.suggestionType === "unlinked_mention" ? (
                      <span><strong>{suggestion.sourceTitle}</strong> mentions this note</span>
                    ) : (
                      <span>Semantically related to <strong>{suggestion.sourceTitle}</strong><span className="matchBadge">{(suggestion.score * 100).toFixed(0)}% Match</span></span>
                    )}
                  </div>
                  {suggestion.excerpt && (
                    <pre className="suggestionExcerpt">{suggestion.excerpt}</pre>
                  )}
                  <div className="suggestionActions">
                    <button
                      onClick={() => void applyBacklinkSuggestion(suggestion)}
                    >
                      {suggestion.suggestionType === "unlinked_mention" ? "Link Mention" : "Add Link"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No link suggestions</p>
          )}
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
