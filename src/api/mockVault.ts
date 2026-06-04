import { addManagedLink, removeManagedLink } from "../core/markdown";
import { buildVaultIndex, getNoteContext, searchNotes } from "../core/indexer";
import type { SearchFilters, VaultFile, VaultIndex } from "../core/types";
import type {
  FileTreeNode,
  GitSettings,
  GitStatus,
  LinkMutationResult,
  NoteDocument,
  SaveResult,
  Snapshot,
  VaultApi,
  VaultSnapshot
} from "./types";

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
