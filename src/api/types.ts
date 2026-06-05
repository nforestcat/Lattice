import type { GraphData, NoteContext, NoteMeta, SearchFilters } from "../core/types";
import type { InboxCaptureBlock } from "../core/capture";

export type VaultSnapshot = {
  rootPath: string;
  notes: NoteMeta[];
  tree: FileTreeNode[];
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
};

export type ContextBundleOptions = {
  selectedPaths?: string[];
  purpose?: string;
  mode?: "short" | "standard" | "full";
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
};
