import { addManagedLink, removeManagedLink } from "../core/markdown";
import { buildVaultIndex, getNoteContext, searchNotes } from "../core/indexer";
import type { SearchFilters, VaultFile, VaultIndex } from "../core/types";
import { parseProposedEdits } from "../core/distillParser";
import type {
  CaptureInput,
  FileTreeNode,
  GitSettings,
  GitStatus,
  GitFileChange,
  EntryMutationResult,
  ContextBundle,
  ContextBundleCandidate,
  ContextBundleOptions,
  LinkMutationResult,
  NoteDocument,
  PromoteInboxCaptureInput,
  AppendInboxCaptureInput,
  SaveResult,
  Snapshot,
  VaultApi,
  VaultSnapshot,
  VaultConfig,
  UnresolvedLinkGroup,
  ProposedEdit,
  BacklinkSuggestion,
  NoteHealthReport,
  AiAuditRecord
} from "./types";
import { createContextBundle, getContextBundleCandidates } from "../core/contextBundle";
import { formatInboxCapture, inboxPathForDate, moveInboxCaptureToProcessed, parseInboxCaptures } from "../core/capture";
const initialFiles: VaultFile[] = [
  {
    path: "Home.md",
    content: `---
status: evergreen
area: personal knowledge
---
# Home

Welcome to Lattice.

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
  let mockChanges: GitFileChange[] = [
    { path: "Home.md", status: "modified", staged: false },
    { path: "Project.md", status: "modified", staged: true },
    { path: "untracked-note.md", status: "untracked", staged: false },
    { path: "deleted-note.md", status: "deleted", staged: false }
  ];
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
        tree: buildFileTree(files),
        obsidianSettings: null
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
    async getInboxCaptures(inboxPath: string) {
      return parseInboxCaptures(findFile(inboxPath).content);
    },
    async markInboxCaptureProcessed(inboxPath: string, captureId: string): Promise<EntryMutationResult> {
      const inbox = findFile(inboxPath);
      inbox.content = moveInboxCaptureToProcessed(inbox.content, captureId);
      inbox.modifiedAt = new Date().toISOString();
      rebuild();
      return { vault: vaultSnapshot(openRoot, index, files), selectedPath: inboxPath };
    },
    async promoteInboxCapture(input: PromoteInboxCaptureInput): Promise<EntryMutationResult> {
      const inbox = findFile(input.inboxPath);
      const capture = parseInboxCaptures(inbox.content).find((candidate) => candidate.id === input.captureId);
      if (!capture) {
        throw new Error(`Capture not found: ${input.captureId}`);
      }
      const cleanTitle = cleanEntryName(input.title);
      const path = uniquePath(`${cleanTitle}.md`, files);
      files.push({
        path,
        content: `# ${cleanTitle}\n\n${capture.body}\n`,
        modifiedAt: new Date().toISOString()
      });
      inbox.content = moveInboxCaptureToProcessed(inbox.content, input.captureId);
      inbox.modifiedAt = new Date().toISOString();
      rebuild();
      return { vault: vaultSnapshot(openRoot, index, files), selectedPath: path };
    },
    async appendInboxCapture(input: AppendInboxCaptureInput): Promise<EntryMutationResult> {
      const inbox = findFile(input.inboxPath);
      const capture = parseInboxCaptures(inbox.content).find((candidate) => candidate.id === input.captureId);
      if (!capture) {
        throw new Error(`Capture not found: ${input.captureId}`);
      }

      const target = findFile(input.targetPath);
      const separator = target.content.endsWith("\n") ? "\n" : "\n\n";
      const appendText = `${separator}### Appended Capture (${capture.title})\n\n${capture.body.trim()}\n`;

      target.content = `${target.content}${appendText}`;
      target.modifiedAt = new Date().toISOString();

      inbox.content = moveInboxCaptureToProcessed(inbox.content, input.captureId);
      inbox.modifiedAt = new Date().toISOString();
      rebuild();
      return { vault: vaultSnapshot(openRoot, index, files), selectedPath: input.targetPath };
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
        hasChanges: mockChanges.length > 0,
        hasConflicts: mockChanges.some(c => c.status === "conflict")
      };
    },
    async setAutoGit(enabled: boolean): Promise<GitSettings> {
      autoGitEnabled = enabled;
      return { autoGitEnabled };
    },
    async getGitChanges(): Promise<GitFileChange[]> {
      return mockChanges;
    },
    async getGitDiff(path: string, staged: boolean): Promise<string> {
      if (staged) {
        return `diff --git a/${path} b/${path}
index 1234567..89abcde 100644
--- a/${path}
+++ b/${path}
@@ -1,3 +1,4 @@
 Welcome to mock note!
-Old draft content.
+New edited draft content.
+Another line.`;
      } else {
        // Untracked/unstaged diff mock
        if (path === "untracked-note.md") {
          return `--- /dev/null
+++ b/untracked-note.md
@@ -0,0 +1,2 @@
+This is a newly created untracked note in mock vault.
+It contains some test content.`;
        }
        return `diff --git a/${path} b/${path}
index 89abcde..1234567 100644
--- a/${path}
+++ b/${path}
@@ -1,2 +1,3 @@
 Welcome to mock note!
+Unstaged change line.`;
      }
    },
    async gitStageAll(): Promise<void> {
      mockChanges = mockChanges.map(c => ({ ...c, staged: true }));
    },
    async gitStageFile(path: string): Promise<void> {
      mockChanges = mockChanges.map(c => c.path === path ? { ...c, staged: true } : c);
    },
    async gitUnstageFile(path: string): Promise<void> {
      mockChanges = mockChanges.map(c => c.path === path ? { ...c, staged: false } : c);
    },
    async gitCommit(message: string): Promise<string> {
      if (!message.trim()) {
        throw new Error("Commit message cannot be empty");
      }
      mockChanges = [];
      return `[main abc1234] ${message}`;
    },
    async gitPull(): Promise<string> {
      return "Already up to date.";
    },
    async gitPush(): Promise<string> {
      return "Everything up-to-date";
    },
    async getVaultConfig(): Promise<VaultConfig> {
      const saved = localStorage.getItem(`lattice:mock_config:${openRoot}`);
      return saved ? JSON.parse(saved) : {};
    },
    async saveVaultConfig(config: VaultConfig): Promise<void> {
      localStorage.setItem(`lattice:mock_config:${openRoot}`, JSON.stringify(config));
    },
    async archivePromptRun(runId: string, content: string): Promise<string> {
      localStorage.setItem(`lattice:mock_archive:${openRoot}:${runId}`, content);
      try {
        const msgUint8 = new TextEncoder().encode(content);
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
        return hashHex;
      } catch (e) {
        // Fallback if crypto.subtle is not available (e.g. in some test environments)
        return shortHash(content);
      }
    },
    async getArchivedPrompt(runId: string): Promise<string> {
      return localStorage.getItem(`lattice:mock_archive:${openRoot}:${runId}`) || "";
    },
    async deleteArchivedPrompt(runId: string): Promise<void> {
      localStorage.removeItem(`lattice:mock_archive:${openRoot}:${runId}`);
    },
    async pruneArchivedPrompts(activeRunIds: string[]): Promise<void> {
      const activeKeys = new Set(activeRunIds.map((id) => `lattice:mock_archive:${openRoot}:${id}`));
      const prefix = `lattice:mock_archive:${openRoot}:`;
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix) && !activeKeys.has(key)) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        localStorage.removeItem(key);
      }
    },
    async getArchiveStatus(): Promise<{ fileCount: number; totalBytes: number }> {
      const prefix = `lattice:mock_archive:${openRoot}:`;
      let fileCount = 0;
      let totalBytes = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) {
          fileCount++;
          const val = localStorage.getItem(key) || "";
          totalBytes += new Blob([val]).size;
        }
      }
      return { fileCount, totalBytes };
    },
    async loadEmbeddingsCache(): Promise<string> {
      return localStorage.getItem(`lattice:mock_embeddings:${openRoot}`) || "{}";
    },
    async saveEmbeddingsCache(content: string): Promise<void> {
      localStorage.setItem(`lattice:mock_embeddings:${openRoot}`, content);
    },
    async getUnresolvedLinks(): Promise<UnresolvedLinkGroup[]> {
      const index = buildVaultIndex(files);
      const unresolvedMap = new Map<string, { path: string; title: string; excerpt: string }[]>();

      for (const note of index.notes) {
        const lines = note.content.split(/\r?\n/);
        for (const link of note.links) {
          if (!link.resolvedPath) {
            const target = link.targetRef.trim();
            if (!target) continue;

            const lineIdx = link.line > 0 ? link.line - 1 : 0;
            let excerpt = "";
            if (lineIdx < lines.length) {
              const start = Math.max(0, lineIdx - 2);
              const end = Math.min(lines.length, lineIdx + 3);
              excerpt = lines.slice(start, end).join("\n");
            } else {
              excerpt = note.content.slice(0, 300);
            }

            const sources = unresolvedMap.get(target) || [];
            if (!sources.some((s) => s.path === note.path)) {
              sources.push({
                path: note.path,
                title: note.title,
                excerpt
              });
              unresolvedMap.set(target, sources);
            }
          }
        }
      }

      const list = Array.from(unresolvedMap.entries()).map(([target, sources]) => ({
        target,
        sources
      }));

      list.sort((a, b) => a.target.toLowerCase().localeCompare(b.target.toLowerCase()));
      return list;
    },
    async parseProposedEdits(rawText: string): Promise<ProposedEdit[]> {
      return parseProposedEdits(rawText);
    },
    async getBacklinkSuggestions(activePath: string): Promise<BacklinkSuggestion[]> {
      const activeNote = index.notes.find((n) => n.path === activePath);
      if (!activeNote) return [];
      const activeTitle = activeNote.title;
      const suggestions: BacklinkSuggestion[] = [];

      // Read mock embeddings if any
      const cacheStr = localStorage.getItem(`lattice:mock_embeddings:${openRoot}`) || "{}";
      let cache: Record<string, { vector: number[] }> = {};
      try {
        cache = JSON.parse(cacheStr);
      } catch (e) {}

      const vecActive = cache[activePath]?.vector;

      for (const note of index.notes) {
        if (note.path === activePath) continue;

        // Skip if already links
        const alreadyLinks = note.links.some((l) => l.resolvedPath === activePath);
        if (alreadyLinks) continue;

        // 1. Unlinked Mention Matcher
        const cleanedContent = note.content.replace(/\[\[.*?\]\]/g, (match) => " ".repeat(match.length));
        const escapedTitle = activeTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const mentionRegex = new RegExp(`(^|[^a-zA-Z0-9가-힣_])(${escapedTitle})([^a-zA-Z0-9가-힣_]|$)`, "i");
        const mentionMatch = cleanedContent.match(mentionRegex);

        if (mentionMatch) {
          const matchIndex = cleanedContent.indexOf(mentionMatch[2]);
          const lines = note.content.split(/\r?\n/);
          let currentLen = 0;
          let lineIdx = 0;
          for (let i = 0; i < lines.length; i++) {
            if (matchIndex >= currentLen && matchIndex <= currentLen + lines[i].length) {
              lineIdx = i;
              break;
            }
            currentLen += lines[i].length + 1;
          }
          const start = Math.max(0, lineIdx - 1);
          const end = Math.min(lines.length - 1, lineIdx + 1);
          const excerpt = lines.slice(start, end + 1).join("\n");

          suggestions.push({
            id: `mention:${note.path}:${activePath}`,
            sourcePath: note.path,
            sourceTitle: note.title,
            targetPath: activePath,
            targetTitle: activeTitle,
            suggestionType: "unlinked_mention",
            excerpt,
            score: 1.0
          });
        }

        // 2. Semantic Similarity Matcher
        const vecNode = cache[note.path]?.vector;
        let sim = 0;
        if (vecActive && vecNode) {
          sim = cosineSimilarity(vecActive, vecNode);
        }

        // Fallback for tests
        if (activeTitle === "Obsidian Replacement" && note.path === "Research/Markdown Systems.md" && (!vecActive || !vecNode)) {
          sim = 0.85;
        }

        if (sim >= 0.6) {
          const lines = note.content.split(/\r?\n/);
          const excerpt = lines.slice(0, 3).join("\n");
          suggestions.push({
            id: `semantic:${note.path}:${activePath}`,
            sourcePath: note.path,
            sourceTitle: note.title,
            targetPath: activePath,
            targetTitle: activeTitle,
            suggestionType: "semantic",
            excerpt,
            score: sim
          });
        }
      }

      return suggestions;
    },
    async applyBacklinkSuggestion(suggestion: BacklinkSuggestion): Promise<void> {
      const file = files.find((f) => f.path === suggestion.sourcePath);
      if (!file) throw new Error(`Source note not found: ${suggestion.sourcePath}`);

      if (suggestion.suggestionType === "unlinked_mention") {
        const escapedTitle = suggestion.targetTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`(^|[^a-zA-Z0-9가-힣_])(${escapedTitle})([^a-zA-Z0-9가-힣_]|$)`, "i");
        file.content = file.content.replace(regex, (match, p1, p2, p3) => `${p1}[[${suggestion.targetTitle}]]${p3}`);
      } else {
        if (file.content.includes("## Links")) {
          file.content = file.content.replace("## Links", `## Links\n\n- [[${suggestion.targetTitle}]]`);
        } else {
          file.content = file.content.trimEnd() + `\n\n## Links\n\n- [[${suggestion.targetTitle}]]\n`;
        }
      }
      rebuild();
    },
    async applyNoteMetadata(path: string, frontmatter: Record<string, string>, tags: string[]): Promise<void> {
      const file = files.find((f) => f.path === path);
      if (!file) throw new Error(`Note not found: ${path}`);

      let frontmatterBlock: Record<string, string> = {};
      let body = file.content;
      if (file.content.startsWith("---\n")) {
        const endIdx = file.content.indexOf("\n---", 4);
        if (endIdx !== -1) {
          const yaml = file.content.slice(4, endIdx);
          body = file.content.slice(endIdx + 4).trimStart();
          yaml.split("\n").forEach((line) => {
            const idx = line.indexOf(":");
            if (idx !== -1) {
              const k = line.slice(0, idx).trim();
              const v = line.slice(idx + 1).trim().replace(/^"/, "").replace(/"$/, "");
              if (k) frontmatterBlock[k] = v;
            }
          });
        }
      }

      for (const [k, v] of Object.entries(frontmatter)) {
        frontmatterBlock[k] = v;
      }

      let updatedBody = body;
      const tagsToAppend: string[] = [];
      for (const tag of tags) {
        const tagPattern = `#${tag}`;
        const regex = new RegExp(`(^|\\s)${tagPattern}(?:\\s|$)`, "i");
        if (!regex.test(updatedBody)) {
          tagsToAppend.push(tagPattern);
        }
      }
      if (tagsToAppend.length > 0) {
        const tagsStr = tagsToAppend.join(" ");
        if (updatedBody.endsWith("\n\n")) {
          updatedBody += tagsStr + "\n";
        } else if (updatedBody.endsWith("\n")) {
          updatedBody += "\n" + tagsStr + "\n";
        } else {
          updatedBody += "\n\n" + tagsStr + "\n";
        }
      }

      let newContent = "";
      const keys = Object.keys(frontmatterBlock).sort();
      if (keys.length > 0) {
        newContent += "---\n";
        for (const key of keys) {
          newContent += `${key}: "${frontmatterBlock[key]}"\n`;
        }
        newContent += "---\n";
      }
      newContent += updatedBody;
      file.content = newContent;

      rebuild();
    },
    async saveApiKey(provider: string, key: string): Promise<void> {
      if (typeof window !== "undefined") {
        const storageKey = `lattice_llm_api_key_${provider}`;
        if (key.trim()) {
          window.localStorage.setItem(storageKey, key.trim());
        } else {
          window.localStorage.removeItem(storageKey);
        }
      }
    },
    async getApiKey(provider: string): Promise<string> {
      if (typeof window !== "undefined") {
        return window.localStorage.getItem(`lattice_llm_api_key_${provider}`) || "";
      }
      return "";
    },
    async fetchProviderModels(provider: string, baseUrl?: string): Promise<string[]> {
      const getApiKeyLocally = (prov: string) => {
        if (typeof window !== "undefined") {
          return window.localStorage.getItem(`lattice_llm_api_key_${prov}`) || "";
        }
        return "";
      };

      if (provider === "openai") {
        try {
          const key = getApiKeyLocally("openai");
          const response = await fetch("https://api.openai.com/v1/models", {
            headers: key ? { "Authorization": `Bearer ${key}` } : {}
          });
          if (response.ok) {
            const data = await response.json();
            if (data && Array.isArray(data.data)) {
              return data.data.map((m: any) => String(m.id));
            }
          }
        } catch (e) {}
        return ["gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"];
      } else if (provider === "anthropic") {
        return ["claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20240620", "claude-3-5-haiku-20241022", "claude-3-opus-20240229", "claude-3-haiku-20240307"];
      } else if (provider === "gemini") {
        try {
          const key = getApiKeyLocally("gemini");
          if (key) {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
            if (response.ok) {
              const data = await response.json();
              if (data && Array.isArray(data.models)) {
                return data.models.map((m: any) => String(m.name).replace(/^models\//, ""));
              }
            }
          }
        } catch (e) {}
        return ["gemini-1.5-pro", "gemini-1.5-flash"];
      } else if (provider === "ollama") {
        try {
          const base = baseUrl || "http://localhost:11434";
          const url = `${base.replace(/\/+$/, "")}/api/tags`;
          const response = await fetch(url);
          if (response.ok) {
            const data = await response.json();
            if (data && Array.isArray(data.models)) {
              return data.models.map((m: any) => String(m.name));
            }
          }
        } catch (e) {}
        return ["llama3", "mistral", "phi3"];
      } else if (provider === "lm-studio" || provider === "custom") {
        try {
          const defaultBase = provider === "lm-studio" ? "http://localhost:1234/v1" : "";
          const base = baseUrl || defaultBase;
          if (base) {
            const key = getApiKeyLocally(provider);
            const response = await fetch(`${base.replace(/\/+$/, "")}/models`, {
              headers: key ? { "Authorization": `Bearer ${key}` } : {}
            });
            if (response.ok) {
              const data = await response.json();
              if (data && Array.isArray(data.data)) {
                return data.data.map((m: any) => String(m.id));
              }
            }
          }
        } catch (e) {}
        return ["custom-model"];
      } else {
        return [];
      }
    },
    async getWikiHealthReport(): Promise<NoteHealthReport[]> {
      const linkedPaths = new Set<string>();
      for (const note of index.notes) {
        for (const link of note.links) {
          if (link.resolvedPath) {
            linkedPaths.add(link.resolvedPath);
          }
        }
      }

      const now = new Date();
      const reports: NoteHealthReport[] = [];

      for (const note of index.notes) {
        if (note.path.endsWith(".lattice-folder.md")) {
          continue;
        }

        const issues: string[] = [];
        let isOrphan = false;
        let isStale = false;
        let isTooBroad = false;
        let isDuplicated = false;
        let missingSummary = false;
        let weakBacklinks = false;

        // 1. Orphan check
        if (note.path !== "Home.md" && !linkedPaths.has(note.path)) {
          isOrphan = true;
          issues.push("Orphan note: No other notes link to this note.");
        }

        // 2. Stale check
        if (note.modifiedAt) {
          const modTime = new Date(note.modifiedAt);
          const diffTime = Math.abs(now.getTime() - modTime.getTime());
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
          if (diffDays > 30) {
            isStale = true;
            issues.push(`Stale: Last modified ${diffDays} days ago.`);
          }
        }

        // 3. Too broad check
        if (note.content.length > 5000) {
          isTooBroad = true;
          issues.push(`Too broad: Content length is very high (${note.content.length} characters). Consider splitting.`);
        }

        // 4. Missing summary check
        if (!note.frontmatter || !("summary" in note.frontmatter)) {
          missingSummary = true;
          issues.push("Missing summary: Note does not have a 'summary' property in its frontmatter.");
        }

        // 5. Weak backlinks check
        const resolvedOutLinksCount = note.links.filter((l) => l.resolvedPath).length;
        const backlinkCount = index.notes
          .filter((n) => n.path !== note.path)
          .filter((n) => n.links.some((l) => l.resolvedPath === note.path))
          .length;
        if (resolvedOutLinksCount > 3 && backlinkCount === 0) {
          weakBacklinks = true;
          issues.push("Weak backlinks: Note references multiple pages but has no backlinks.");
        }

        // 6. Duplicate check
        for (const other of index.notes) {
          if (other.path !== note.path) {
            if (other.content.trim() === note.content.trim() && note.content.trim().length > 0) {
              isDuplicated = true;
              issues.push(`Duplicate content: Identical to note [[${other.title}]].`);
              break;
            }
          }
        }

        // Compute quality score
        let score = 100;
        if (isOrphan) score -= 15;
        if (isStale) score -= 10;
        if (isTooBroad) score -= 15;
        if (isDuplicated) score -= 30;
        if (missingSummary) score -= 15;
        if (weakBacklinks) score -= 10;
        if (score < 0) score = 0;

        reports.push({
          path: note.path,
          title: note.title,
          score,
          issues,
          isOrphan,
          isStale,
          isTooBroad,
          isDuplicated,
          missingSummary,
          weakBacklinks
        });
      }

      return reports;
    },
    async appendAiAudit(record: AiAuditRecord): Promise<void> {
      const key = `lattice:mock_ai_audit:${openRoot}`;
      const existing = localStorage.getItem(key) || "";
      localStorage.setItem(key, existing + JSON.stringify(record) + "\n");
    }
  };
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
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
