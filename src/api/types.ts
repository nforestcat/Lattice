import type { GraphData, NoteContext, NoteMeta, SearchFilters } from "../core/types";
export type { GraphData, NoteContext, NoteMeta, SearchFilters };
import type { InboxCaptureBlock } from "../core/capture";
import type { AiAuditRecord, AiProvenance, ReviewDecisionRecord } from "./ingestReviewTypes";
import type { GitFileChange, GitSettings, GitStatus, PullPreflight, StashPopResult } from "./gitTypes";
import type { LlmConfig, VaultConfig } from "./configTypes";
export type {
  LlmConfig,
  LlmProvider,
  NoteTemplate,
  PromptRun,
  PromptTemplate,
  VaultConfig,
} from "./configTypes";
export type {
  GitFileChange,
  GitSettings,
  GitStatus,
  PullPreflight,
  StashPopResult,
} from "./gitTypes";
export type {
  AiAuditRecord,
  AiProvenance,
  IngestDuplicateCheck,
  IngestQueueItem,
  IngestQueueUpdate,
  IngestRaw,
  IngestResult,
  IngestSimilarNote,
  MaintenanceSuggestionKind,
  ReviewDecisionRecord,
  ReviewItemKind,
  ReviewItemStatus,
  ReviewQueueItem,
} from "./ingestReviewTypes";

export type VaultSnapshot = {
  rootPath: string;
  notes: NoteMeta[];
  tree: FileTreeNode[];
  obsidianSettings?: ObsidianSettings | null;
  reviewDecisions?: ReviewDecisionRecord[];
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
  gitSuggestCommitMessage(): Promise<string>;
  gitPullPreflight: () => Promise<PullPreflight>;
  gitStashPush: () => Promise<string>;
  gitStashPop: (withIndex: boolean) => Promise<StashPopResult>;
  gitStashDrop: () => Promise<string>;
  gitMergeHeadExists: () => Promise<boolean>;
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
  persistReviewDecisions(decisions: ReviewDecisionRecord[]): Promise<void>;
};

export type DuplicatePeerInfo = {
  path: string;
  score: number;
  modifiedAt?: string;
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
  duplicatePeer?: DuplicatePeerInfo;
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

