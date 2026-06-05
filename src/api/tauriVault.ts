import { invoke } from "@tauri-apps/api/core";
import type { SearchFilters } from "../core/types";
import type {
  AppendInboxCaptureInput,
  CaptureInput,
  ContextBundle,
  ContextBundleCandidate,
  ContextBundleOptions,
  EntryMutationResult,
  GitSettings,
  LinkMutationResult,
  NoteDocument,
  PromoteInboxCaptureInput,
  SaveResult,
  Snapshot,
  VaultApi,
  VaultSnapshot,
  VaultConfig
} from "./types";

export function createTauriVaultApi(): VaultApi {
  return {
    openVault: (path: string) => invoke<VaultSnapshot>("open_vault", { path }),
    readNote: (path: string) => invoke<NoteDocument>("read_note", { path }),
    saveNote: (path: string, content: string, baseRevision: string) =>
      invoke<SaveResult>("save_note", { path, content, baseRevision }),
    createNote: (parentPath: string | null, title: string) =>
      invoke<EntryMutationResult>("create_note", { parentPath, title }),
    createFolder: (parentPath: string | null, name: string) =>
      invoke<EntryMutationResult>("create_folder", { parentPath, name }),
    renameEntry: (path: string, newName: string) =>
      invoke<EntryMutationResult>("rename_entry", { path, newName }),
    deleteEntry: (path: string) => invoke<EntryMutationResult>("delete_entry", { path }),
    captureToInbox: (input: CaptureInput) => invoke<EntryMutationResult>("capture_to_inbox", { input }),
    getInboxCaptures: (inboxPath: string) => invoke("get_inbox_captures", { inboxPath }),
    markInboxCaptureProcessed: (inboxPath: string, captureId: string) =>
      invoke<EntryMutationResult>("mark_inbox_capture_processed", { inboxPath, captureId }),
    promoteInboxCapture: (input: PromoteInboxCaptureInput) =>
      invoke<EntryMutationResult>("promote_inbox_capture", { input }),
    appendInboxCapture: (input: AppendInboxCaptureInput) =>
      invoke<EntryMutationResult>("append_inbox_capture", { input }),
    getContextBundle: (path: string, options?: ContextBundleOptions) =>
      invoke<ContextBundle>("get_context_bundle", { path, options: options ?? {} }),
    getContextBundleCandidates: (path: string) =>
      invoke<ContextBundleCandidate[]>("get_context_bundle_candidates", { path }),
    searchNotes: (filters: SearchFilters) => invoke("search_notes", { filters }),
    getNoteContext: (path: string) => invoke("get_note_context", { path }),
    getGraph: (filters?: Record<string, unknown>) => invoke("get_graph", { filters: filters ?? {} }),
    createGraphLink: (sourcePath: string, targetPath: string) =>
      invoke<LinkMutationResult>("create_graph_link", { sourcePath, targetPath }),
    deleteManagedGraphLink: (sourcePath: string, targetPath: string) =>
      invoke<LinkMutationResult>("delete_managed_graph_link", { sourcePath, targetPath }),
    listSnapshots: (path: string) => invoke<Snapshot[]>("list_snapshots", { path }),
    restoreSnapshot: (snapshotId: string) => invoke("restore_snapshot", { snapshotId }),
    getGitStatus: () => invoke("get_git_status"),
    setAutoGit: (enabled: boolean) => invoke<GitSettings>("set_auto_git", { enabled }),
    getVaultConfig: () => invoke<VaultConfig>("get_vault_config"),
    saveVaultConfig: (config: VaultConfig) => invoke<void>("save_vault_config", { config }),
    archivePromptRun: (runId: string, content: string) => invoke<string>("archive_prompt_run", { runId, content }),
    getArchivedPrompt: (runId: string) => invoke<string>("get_archived_prompt", { runId }),
    deleteArchivedPrompt: (runId: string) => invoke<void>("delete_archived_prompt", { runId }),
    pruneArchivedPrompts: (activeRunIds: string[]) => invoke<void>("prune_archived_prompts", { activeRunIds }),
    getArchiveStatus: () => invoke<{ fileCount: number; totalBytes: number }>("get_archive_status")
  };
}
