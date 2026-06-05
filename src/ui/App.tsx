import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { vaultApi } from "../api";
import { isDesktopRuntime, pickVaultFolder } from "../api/dialog";
import type { ContextBundle, ContextBundleCandidate, FileTreeNode, GitStatus, NoteDocument, Snapshot, VaultSnapshot, VaultConfig, PromptRun, PromptTemplate } from "../api/types";
import type { InboxCaptureBlock } from "../core/capture";
import type { GraphData, NoteContext, NoteMeta } from "../core/types";
import { renderMarkdownPreview } from "./markdownPreview";
import { getStartupVaultPath, rememberVaultPath } from "./vaultStartup";

type ViewMode = "split" | "edit" | "preview" | "graph";

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
    promptTemplates: normalizePromptTemplates(config?.promptTemplates)
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
  const [results, setResults] = useState<NoteMeta[]>([]);
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

  async function runSearch(nextQuery = query, nextTag = tagFilter, nextProperty = propertyFilter) {
    const frontmatter = parsePropertyFilter(nextProperty);
    const notes = await vaultApi.searchNotes({
      query: nextQuery,
      tags: nextTag ? [nextTag] : [],
      frontmatter
    });
    setResults(notes);
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
    if (!window.confirm(`Remove managed graph link to "${targetPath}"?`)) {
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
    if (!window.confirm(message)) {
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
    const combined = promptInstruction.trim()
      ? `${promptInstruction.trim()}\n\n---\n\n${contextBundle.markdown}`
      : contextBundle.markdown;
    try {
      await navigator.clipboard.writeText(combined);
      setStatus("Combined prompt copied");

      let hVal = 0;
      for (let i = 0; i < combined.length; i++) {
        hVal = (Math.imul(31, hVal) + combined.charCodeAt(i)) | 0;
      }
      const promptHash = Math.abs(hVal).toString(16);
      const preview = combined.slice(0, 1500) + (combined.length > 1500 ? "..." : "");

      const newRun: PromptRun = {
        id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11),
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
      setStatus(`Copied full prompt for ${run.activePath.split('/').pop() || run.activePath} from history!`);
    } catch (err) {
      setStatus(errorMessage(err));
    }
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
    if (!window.confirm("Are you sure you want to delete this custom template?")) {
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
          <strong>Local Vault</strong>
          <span>{vault?.rootPath ?? "No vault"}</span>
        </div>
        <button className="primary" onClick={() => void chooseVaultFolder()}>Open vault</button>
        <SearchPanel
          query={query}
          tagFilter={tagFilter}
          propertyFilter={propertyFilter}
          tags={allTags}
          onQuery={(value) => {
            setQuery(value);
            void runSearch(value, tagFilter, propertyFilter);
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
          <h2>Search</h2>
          {results.map((note) => (
            <button key={note.path} className="result" onClick={() => void selectNote(note.path)}>
              <strong>{note.title}</strong>
              <span>{note.path}</span>
            </button>
          ))}
        </section>
      </aside>

      <section className="editorPane">
        <header className="topbar">
          <div>
            <strong>{context?.note.title ?? "Select a note"}</strong>
            <span>{activePath}</span>
          </div>
          <div className="segmented">
            <button className={viewMode === "split" ? "active" : ""} onClick={() => setViewMode("split")}>Split</button>
            <button className={viewMode === "edit" ? "active" : ""} onClick={() => setViewMode("edit")}>Edit</button>
            <button className={viewMode === "preview" ? "active" : ""} onClick={() => setViewMode("preview")}>Preview</button>
            <button className={viewMode === "graph" ? "active" : ""} onClick={() => setViewMode("graph")}>Graph</button>
          </div>
          <button className="primary" onClick={() => void saveActiveNote()}>Save</button>
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
            <h3>Related Candidates ({displayedCandidates.length})</h3>
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
  onQuery(value: string): void;
  onTag(value: string): void;
  onProperty(value: string): void;
}) {
  return (
    <section className="searchPanel">
      <input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="Search notes" />
      <select value={props.tagFilter} onChange={(event) => props.onTag(event.target.value)}>
        <option value="">All tags</option>
        {props.tags.map((tag) => <option key={tag} value={tag}>#{tag}</option>)}
      </select>
      <input value={props.propertyFilter} onChange={(event) => props.onProperty(event.target.value)} placeholder="status=draft" />
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
