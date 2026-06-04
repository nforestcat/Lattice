import { invoke } from "@tauri-apps/api/core";
import type { SearchFilters } from "../core/types";
import type { GitSettings, LinkMutationResult, NoteDocument, SaveResult, Snapshot, VaultApi, VaultSnapshot } from "./types";

export function createTauriVaultApi(): VaultApi {
  return {
    openVault: (path: string) => invoke<VaultSnapshot>("open_vault", { path }),
    readNote: (path: string) => invoke<NoteDocument>("read_note", { path }),
    saveNote: (path: string, content: string, baseRevision: string) =>
      invoke<SaveResult>("save_note", { path, content, baseRevision }),
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
    setAutoGit: (enabled: boolean) => invoke<GitSettings>("set_auto_git", { enabled })
  };
}
