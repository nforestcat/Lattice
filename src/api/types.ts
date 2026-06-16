import type { GraphData, NoteContext, NoteMeta, SearchFilters } from "../core/types";
export type { GraphData, NoteContext, NoteMeta, SearchFilters };
import type { InboxCaptureBlock } from "../core/capture";

export type VaultSnapshot = {
  rootPath: string;
  notes: NoteMeta[];
  tree: FileTreeNode[];
  obsidianSettings?: ObsidianSettings | null;
};

export type ObsidianSettings = {
  detected: boolean;
  readableLineLength?: boolean | null;
  theme?: string | null;
  accentColor?: string | null;
  enabledCorePlugins?: string[];
  attachmentFolderPath?: string | null;
  cssSnippets?: string[];
  hotkeys?: Record<string, any> | null;
};

export type FileTreeNode = {
  name: string;
  path: string;
  kind: "folder" | "note";
  children: FileTreeNode[];
};

export type NoteDocument = {
  path: string;
  content: string;
  revision: string;
};

export type SaveResult = {
  saved: boolean;
  revision: string;
  conflict: boolean;
  snapshotId: string | null;
  gitCommit: string | null;
};

export type Snapshot = {
  id: string;
  path: string;
  createdAt: string;
  reason: "save" | "conflict" | "restore";
};

export type GitStatus = {
  isRepo: boolean;
  autoGitEnabled: boolean;
  branch: string | null;
  hasChanges: boolean;
  hasConflicts: boolean;
};

export type GitSettings = {
  autoGitEnabled: boolean;
};

export type LinkMutationResult = {
  note: NoteDocument;
  graph: GraphData;
};

export type EntryMutationResult = {
  vault: VaultSnapshot;
  selectedPath: string | null;
};

export type CaptureInput = {
  content: string;
  relatedPath?: string | null;
  capturedAt?: string;
};

export type PromoteInboxCaptureInput = {
  inboxPath: string;
  captureId: string;
  title: string;
};

export type AppendInboxCaptureInput = {
  inboxPath: string;
  captureId: string;
  targetPath: string;
};

export type ContextBundle = {
  title: string;
  focusPath: string;
  notePaths: string[];
  markdown: string;
  estimatedTokens: number;
};

export type ContextBundleOptions = {
  selectedPaths?: string[];
  purpose?: string;
  mode?: "short" | "standard" | "full";
  preset?: string;
};

export type ContextBundleCandidate = {
  path: string;
  title: string;
  reason: "Focus" | "Outgoing" | "Backlink" | "Recommended";
  reasonDetail: string;
  score: number;
  excerpt: string;
  tokenEstimate: number;
  selected: boolean;
  characterCount: number;
};

export type UnresolvedLinkSource = {
  path: string;
  title: string;
  excerpt: string;
};

export type UnresolvedLinkGroup = {
  target: string;
  sources: UnresolvedLinkSource[];
};

export type IngestRaw = {
  title?: string;
  text: string;
  sourceRef: string;
  sourceType?: "url" | "pdf" | "text";
  ingestDate?: string;
};

export type IngestResult = {
  title: string;
  markdown: string;
  tags: string[];
};

export type VaultApi = {
  openVault(path: string): Promise<VaultSnapshot>;
  readNote(path: string): Promise<NoteDocument>;
  saveNote(path: string, content: string, baseRevision: string): Promise<SaveResult>;
  createNote(parentPath: string | null, title: string): Promise<EntryMutationResult>;
  createFolder(parentPath: string | null, name: string): Promise<EntryMutationResult>;
  renameEntry(path: string, newName: string): Promise<EntryMutationResult>;
  deleteEntry(path: string): Promise<EntryMutationResult>;
  captureToInbox(input: CaptureInput): Promise<EntryMutationResult>;
  getInboxCaptures(inboxPath: string): Promise<InboxCaptureBlock[]>;
  markInboxCaptureProcessed(inboxPath: string, captureId: string): Promise<EntryMutationResult>;
  promoteInboxCapture(input: PromoteInboxCaptureInput): Promise<EntryMutationResult>;
  appendInboxCapture(input: AppendInboxCaptureInput): Promise<EntryMutationResult>;
  getContextBundle(path: string, options?: ContextBundleOptions): Promise<ContextBundle>;
  getContextBundleCandidates(path: string): Promise<ContextBundleCandidate[]>;
  searchNotes(filters: SearchFilters): Promise<NoteMeta[]>;
  getNoteContext(path: string): Promise<NoteContext>;
  getGraph(filters?: Record<string, unknown>): Promise<GraphData>;
  createGraphLink(sourcePath: string, targetPath: string): Promise<LinkMutationResult>;
  deleteManagedGraphLink(sourcePath: string, targetPath: string): Promise<LinkMutationResult>;
  listSnapshots(path: string): Promise<Snapshot[]>;
  restoreSnapshot(snapshotId: string): Promise<SaveResult>;
  getGitStatus(): Promise<GitStatus>;
  setAutoGit(enabled: boolean): Promise<GitSettings>;
  getGitChanges(): Promise<GitFileChange[]>;
  getGitDiff(path: string, staged: boolean): Promise<string>;
  gitStageAll(): Promise<void>;
  gitStageFile(path: string): Promise<void>;
  gitUnstageFile(path: string): Promise<void>;
  gitCommit(message: string): Promise<string>;
  gitPull(): Promise<string>;
  gitPush(): Promise<string>;
  getVaultConfig(): Promise<VaultConfig>;
  saveVaultConfig(config: VaultConfig): Promise<void>;
  archivePromptRun(runId: string, content: string): Promise<string>;
  getArchivedPrompt(runId: string): Promise<string>;
  deleteArchivedPrompt(runId: string): Promise<void>;
  pruneArchivedPrompts(activeRunIds: string[]): Promise<void>;
  getArchiveStatus(): Promise<{ fileCount: number; totalBytes: number }>;
  loadEmbeddingsCache(): Promise<string>;
  saveEmbeddingsCache(content: string): Promise<void>;
  loadEmbeddingsStatus(): Promise<string>;
  saveEmbeddingsStatus(content: string): Promise<void>;
  getUnresolvedLinks(): Promise<UnresolvedLinkGroup[]>;
  parseProposedEdits(rawText: string): Promise<ProposedEdit[]>;
  getBacklinkSuggestions(activePath: string): Promise<BacklinkSuggestion[]>;
  applyBacklinkSuggestion(suggestion: BacklinkSuggestion): Promise<void>;
  applyNoteMetadata(path: string, frontmatter: Record<string, string>, tags: string[]): Promise<void>;
  saveApiKey(provider: string, key: string): Promise<void>;
  getApiKey(provider: string): Promise<string>;
  fetchProviderModels(provider: string, baseUrl?: string): Promise<string[]>;
  getWikiHealthReport(): Promise<NoteHealthReport[]>;
  appendAiAudit(record: AiAuditRecord): Promise<void>;
};

export type AiAuditRecord = {
  editId: string;
  editType: "create" | "update" | "merge" | "delete";
  path: string;
  promptRunId?: string | null;
  model?: string;
  source: string;
  appliedAt: string;
  confidence?: number;
};

export type NoteHealthReport = {
  path: string;
  title: string;
  score: number;
  issues: string[];
  isOrphan: boolean;
  isStale: boolean;
  isTooBroad: boolean;
  isDuplicated: boolean;
  missingSummary: boolean;
  weakBacklinks: boolean;
};

export type BacklinkSuggestion = {
  id: string;
  sourcePath: string;
  sourceTitle: string;
  targetPath: string;
  targetTitle: string;
  suggestionType: "unlinked_mention" | "semantic";
  excerpt: string;
  score: number;
};

export type PromptRun = {
  id: string;
  question: string;
  selectedNotes: string[];
  preset: string;
  purpose: string;
  mode: "short" | "standard" | "full";
  tokenCount: number;
  createdAt: string;
  activePath: string;
  promptHash?: string;
  preview?: string;
};

export type PromptTemplate = {
  id: string;
  name: string;
  template: string;
  isSystem?: boolean;
};

export type LlmProvider = "openai" | "anthropic" | "gemini" | "ollama" | "custom" | "lm-studio";

export type LlmConfig = {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  embeddingModel?: string;
  embeddingProvider?: "openai" | "ollama" | "custom" | "local-onnx";
};

export type NoteTemplate = {
  name: string;
  description: string;
  prompt: string;
};

export type VaultConfig = {
  version?: number;
  contextLimit?: number;
  bundlePreset?: string;
  bundlePurpose?: string;
  bundleMode?: "short" | "standard" | "full";
  selectedPaths?: Record<string, string[]>;
  promptInstructions?: Record<string, string>;
  promptRuns?: PromptRun[];
  promptTemplates?: PromptTemplate[];
  llmConfig?: LlmConfig;
  archiveRetentionPolicy?: string;
  noteTemplates?: NoteTemplate[];
  maintenanceSuggestions?: Record<string, { proposed: string; provenance: AiProvenance; generatedAt: string }>;
};

export type AiProvenance = {
  source: string;
  promptRunId?: string | null;
  contextBundlePaths?: string[];
  originalExcerpt?: string;
  confidence?: number;
  model?: string;
  appliedAt?: string;
};

export type ProposedEdit = {
  id: string;
  type: "create" | "update" | "merge" | "delete";
  path: string;
  newPath?: string;
  content?: string;
  targetContent?: string;
  replacementContent?: string;
  reason?: string;
  applied: boolean;
  checked?: boolean;
  provenance?: AiProvenance;
};

export type StubDraftReview = {
  content: string;
  status: "done" | "drafting" | "error";
  approved: boolean;
};

export type GitFileChange = {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflict";
  staged: boolean;
};

export type ReviewItemKind =
  | "inbox_capture"
  | "ingest_draft"
  | "proposed_edit"
  | "missing_summary"
  | "dead_link"
  | "backlink_suggestion"
  | "duplicate_warning"
  | "orphan_note"
  | "stale_note"
  | "too_broad"
  | "weak_backlinks";

export type MaintenanceSuggestionKind =
  | "split"
  | "summary"
  | "link_candidates"
  | "review_prompt"
  | "merge_or_delete"
  | "backlinks_in";

export type ReviewItemStatus =
  | "new"
  | "drafted"
  | "approved"
  | "applied"
  | "rejected"
  | "committed";

export interface ReviewQueueItem {
  id: string;
  sourceId: string;
  kind: ReviewItemKind;
  status: ReviewItemStatus;
  path: string;
  title: string;
  original?: string;
  proposed?: string;
  reason?: string;
  gitStaged: boolean;
  createdAt: number;
  sourceRef?: unknown;
  provenance?: AiProvenance;
  suggestionKind?: MaintenanceSuggestionKind;
}


