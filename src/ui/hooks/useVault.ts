import { useRef, useState, useMemo } from "react";
import { vaultApi } from "../../api";
import { askConfirm } from "../../api/dialog";
import type { FileTreeNode, NoteDocument, NoteHealthReport, Snapshot, VaultConfig, VaultSnapshot } from "../../api/types";
import type { NoteContext, NoteMeta } from "../../core/types";
import { VAULT_CONFIG_VERSION, sanitizeVaultConfig, errorMessage } from "./contextShared";

type ViewMode = "split" | "edit" | "preview" | "graph" | "distill";

export interface UseVaultCallbacks {
  setResults: (notes: NoteMeta[]) => void;
  selectNote: (path: string) => Promise<void>;
  refreshVault: (path: string | null) => Promise<void>;
  clearActiveNoteState: () => void;
}

function currentFolderPath(activePath: string | null): string | null {
  if (!activePath) {
    return null;
  }
  const index = activePath.lastIndexOf("/");
  return index === -1 ? null : activePath.slice(0, index);
}

export function useVault(callbacks: UseVaultCallbacks) {
  const {
    setResults,
    selectNote,
    refreshVault,
    clearActiveNoteState,
  } = callbacks;

  const [vault, setVault] = useState<VaultSnapshot | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [document, setDocument] = useState<NoteDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [status, setStatus] = useState("Ready");
  const [vaultConfig, setVaultConfig] = useState<VaultConfig>({});
  const vaultConfigRef = useRef<VaultConfig>({});
  const [context, setContext] = useState<NoteContext | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [healthReports, setHealthReports] = useState<NoteHealthReport[]>([]);
  const [isScanningHealth, setIsScanningHealth] = useState(false);

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
        clearActiveNoteState();
      }
      void runHealthAudit();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  return {
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
    healthReports, setHealthReports,
    isScanningHealth,
    globalHealthScore,
    runHealthAudit,
  };
}
