import { addManagedLink, removeManagedLink } from "../core/markdown";
import { buildVaultIndex, getNoteContext, searchNotes } from "../core/indexer";
import type { SearchFilters, VaultFile, VaultIndex } from "../core/types";
import type {
  CaptureInput,
  FileTreeNode,
  GitSettings,
  GitStatus,
  EntryMutationResult,
  ContextBundle,
  ContextBundleCandidate,
  ContextBundleOptions,
  LinkMutationResult,
  NoteDocument,
  SaveResult,
  Snapshot,
  VaultApi,
  VaultSnapshot
} from "./types";
import { createContextBundle, getContextBundleCandidates } from "../core/contextBundle";
import { formatInboxCapture, inboxPathForDate } from "../core/capture";

const initialFiles: VaultFile[] = [
  {
    path: "Home.md",
    content: `---
status: evergreen
area: personal knowledge
---
# Home

Welcome to the local vault.

Explore [[Projects/Obsidian Replacement]] and [[Research/Markdown Systems]].

#home #dashboard
`
  },
  {
    path: "Projects/Obsidian Replacement.md",
    content: `---
status: draft
area: product
---
# Obsidian Replacement

Build a local-first Markdown app with backlinks, search, and graph editing.

## Links

- [[Home]]
- [[Research/Markdown Systems]]

#project #notes
`
  },
  {
    path: "Research/Markdown Systems.md",
    content: `# Markdown Systems

Markdown stays portable when links are stored as plain [[Home]] wiki links.

#research
`
  },
  {
    path: "일지/한글 노트.md",
    content: `---
status: draft
---
# 한글 노트

Windows 경로와 한글 파일명을 확인하는 노트입니다. [[Home]]

#프로젝트/위키
`
  }
];

export function createMockVaultApi(): VaultApi {
  let files = [...initialFiles];
  let index = buildVaultIndex(files);
  let openRoot = "Demo Vault";
  let autoGitEnabled = false;
  let snapshots: Snapshot[] = [];
  const snapshotContent = new Map<string, string>();

  function rebuild() {
    index = buildVaultIndex(files);
  }

  function findFile(path: string): VaultFile {
    const file = files.find((candidate) => candidate.path === path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    return file;
  }

  function createSnapshot(path: string, reason: Snapshot["reason"]): string {
    const file = findFile(path);
    const id = `${path}:${Date.now()}`;
    snapshots = [
      {
        id,
        path,
        createdAt: new Date().toISOString(),
        reason
      },
      ...snapshots
    ];
    snapshotContent.set(id, file.content);
    return id;
  }

  return {
    async openVault(path: string): Promise<VaultSnapshot> {
      openRoot = path || "Demo Vault";
      rebuild();
      return {
        rootPath: openRoot,
        notes: index.notes,
        tree: buildFileTree(files)
      };
    },
    async readNote(path: string): Promise<NoteDocument> {
      const file = findFile(path);
      return {
        path,
        content: file.content,
        revision: revisionOf(file.content)
      };
    },
    async saveNote(path: string, content: string, baseRevision: string): Promise<SaveResult> {
      const file = findFile(path);
      const currentRevision = revisionOf(file.content);
      if (baseRevision && baseRevision !== currentRevision) {
        const snapshotId = createSnapshot(path, "conflict");
        return {
          saved: false,
          revision: currentRevision,
          conflict: true,
          snapshotId,
          gitCommit: null
        };
      }

      const snapshotId = createSnapshot(path, "save");
      file.content = content;
      file.modifiedAt = new Date().toISOString();
      rebuild();
      return {
        saved: true,
        revision: revisionOf(content),
        conflict: false,
        snapshotId,
        gitCommit: autoGitEnabled ? shortHash(`${path}:${content}`) : null
      };
    },
    async createNote(parentPath: string | null, title: string): Promise<EntryMutationResult> {
      const cleanTitle = cleanEntryName(title);
      const path = uniquePath(joinPath(parentPath, `${cleanTitle}.md`), files);
      files.push({
        path,
        content: `# ${cleanTitle}\n`,
        modifiedAt: new Date().toISOString()
      });
      rebuild();
      return { vault: vaultSnapshot(openRoot, index, files), selectedPath: path };
    },
    async createFolder(parentPath: string | null, name: string): Promise<EntryMutationResult> {
      const cleanName = cleanEntryName(name);
      const folderPath = joinPath(parentPath, cleanName);
      if (entryExists(folderPath, files)) {
        throw new Error(`Entry already exists: ${folderPath}`);
      }
      files.push({
        path: joinPath(folderPath, ".lattice-folder.md"),
        content: `# ${cleanName}\n`,
        modifiedAt: new Date().toISOString()
      });
      rebuild();
      return { vault: vaultSnapshot(openRoot, index, files), selectedPath: folderPath };
    },
    async renameEntry(path: string, newName: string): Promise<EntryMutationResult> {
      const cleanName = cleanEntryName(newName);
      const isNote = path.toLowerCase().endsWith(".md");
      const parentPath = parentOf(path);
      const nextPath = joinPath(parentPath, isNote ? `${cleanName}.md` : cleanName);
      if (entryExists(nextPath, files)) {
        throw new Error(`Entry already exists: ${nextPath}`);
      }
      const prefix = `${path}/`;
      let changed = false;
      files = files.map((file) => {
        if (file.path === path) {
          changed = true;
          return { ...file, path: nextPath };
        }
        if (file.path.startsWith(prefix)) {
          changed = true;
          return { ...file, path: `${nextPath}/${file.path.slice(prefix.length)}` };
        }
        return file;
      });
      if (!changed) {
        throw new Error(`Entry not found: ${path}`);
      }
      rebuild();
      return { vault: vaultSnapshot(openRoot, index, files), selectedPath: nextPath };
    },
    async deleteEntry(path: string): Promise<EntryMutationResult> {
      const isNote = files.some((file) => file.path === path);
      const prefix = `${path}/`;
      const descendants = files.filter((file) => file.path.startsWith(prefix));
      if (!isNote && descendants.length > 0) {
        throw new Error("Folder is not empty");
      }
      const before = files.length;
      files = files.filter((file) => file.path !== path);
      if (files.length === before) {
        throw new Error(`Entry not found: ${path}`);
      }
      rebuild();
      return { vault: vaultSnapshot(openRoot, index, files), selectedPath: files[0]?.path ?? null };
    },
    async captureToInbox(input: CaptureInput): Promise<EntryMutationResult> {
      const capturedAt = input.capturedAt ? new Date(input.capturedAt) : new Date();
      const path = inboxPathForDate(capturedAt);
      const relatedTitle = input.relatedPath ? getNoteContext(index, input.relatedPath).note.title : null;
      const capture = formatInboxCapture({
        content: input.content,
        relatedTitle,
        capturedAt
      });
      const existing = files.find((file) => file.path === path);
      if (existing) {
        existing.content = `${existing.content.trimEnd()}\n\n${capture}`;
        existing.modifiedAt = new Date().toISOString();
      } else {
        files.push({
          path,
          content: `# ${path.replace(/^Inbox\//, "").replace(/\.md$/i, "")}\n\n${capture}`,
          modifiedAt: new Date().toISOString()
        });
      }
      rebuild();
      return { vault: vaultSnapshot(openRoot, index, files), selectedPath: path };
    },
    async getContextBundle(path: string, options?: ContextBundleOptions): Promise<ContextBundle> {
      return createContextBundle(index, path, options);
    },
    async getContextBundleCandidates(path: string): Promise<ContextBundleCandidate[]> {
      return getContextBundleCandidates(index, path);
    },
    async searchNotes(filters: SearchFilters) {
      return searchNotes(index, filters);
    },
    async getNoteContext(path: string) {
      return getNoteContext(index, path);
    },
    async getGraph() {
      return index.graph;
    },
    async createGraphLink(sourcePath: string, targetPath: string): Promise<LinkMutationResult> {
      const target = getNoteContext(index, targetPath).note;
      const source = findFile(sourcePath);
      source.content = addManagedLink(source.content, target.title);
      rebuild();
      return {
        note: await this.readNote(sourcePath),
        graph: index.graph
      };
    },
    async deleteManagedGraphLink(sourcePath: string, targetPath: string): Promise<LinkMutationResult> {
      const target = getNoteContext(index, targetPath).note;
      const source = findFile(sourcePath);
      source.content = removeManagedLink(source.content, target.title);
      rebuild();
      return {
        note: await this.readNote(sourcePath),
        graph: index.graph
      };
    },
    async listSnapshots(path: string) {
      return snapshots.filter((snapshot) => snapshot.path === path);
    },
    async restoreSnapshot(snapshotId: string) {
      const snapshot = snapshots.find((candidate) => candidate.id === snapshotId);
      const content = snapshotContent.get(snapshotId);
      if (!snapshot || content === undefined) {
        throw new Error(`Snapshot not found: ${snapshotId}`);
      }

      const file = findFile(snapshot.path);
      file.content = content;
      rebuild();
      return {
        saved: true,
        revision: revisionOf(content),
        conflict: false,
        snapshotId,
        gitCommit: null
      };
    },
    async getGitStatus(): Promise<GitStatus> {
      return {
        isRepo: true,
        autoGitEnabled,
        branch: "main",
        hasChanges: false
      };
    },
    async setAutoGit(enabled: boolean): Promise<GitSettings> {
      autoGitEnabled = enabled;
      return { autoGitEnabled };
    }
  };
}

function vaultSnapshot(rootPath: string, index: VaultIndex, files: VaultFile[]): VaultSnapshot {
  return {
    rootPath,
    notes: index.notes,
    tree: buildFileTree(files)
  };
}

function buildFileTree(files: VaultFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    let level = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      const kind = index === parts.length - 1 ? "note" : "folder";
      let node = level.find((candidate) => candidate.path === path);
      if (!node) {
        node = { name: part, path, kind, children: [] };
        level.push(node);
      }
      level = node.children;
    });
  }
  return root;
}

function cleanEntryName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]/g, "-");
  if (!cleaned) {
    throw new Error("Entry name is required");
  }
  return cleaned;
}

function joinPath(parentPath: string | null | undefined, name: string): string {
  return parentPath ? `${parentPath.replace(/\/+$/g, "")}/${name}` : name;
}

function parentOf(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index === -1 ? null : path.slice(0, index);
}

function entryExists(path: string, files: VaultFile[]): boolean {
  return files.some((file) => file.path === path || file.path.startsWith(`${path}/`));
}

function uniquePath(path: string, files: VaultFile[]): string {
  if (!entryExists(path, files)) {
    return path;
  }
  const extension = path.endsWith(".md") ? ".md" : "";
  const base = extension ? path.slice(0, -extension.length) : path;
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}${extension}`;
    if (!entryExists(candidate, files)) {
      return candidate;
    }
  }
}

function revisionOf(content: string): string {
  return shortHash(content);
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}
