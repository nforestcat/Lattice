import { parseMarkdownNote } from "./markdown";
import type { GraphData, NoteContext, NoteLink, ParsedNote, SearchFilters, SearchResult, VaultFile, VaultIndex } from "./types";

export function buildVaultIndex(files: VaultFile[]): VaultIndex {
  const notes = files.map((file) => ({
    ...parseMarkdownNote(file.path, file.content),
    modifiedAt: file.modifiedAt
  }));
  const pathByTarget = buildTargetResolver(notes);
  const resolvedNotes = notes.map((note) => ({
    ...note,
    links: note.links.map((link) => ({
      ...link,
      resolvedPath: pathByTarget.get(normalizeRef(link.targetRef)) ?? null
    }))
  }));

  return {
    notes: resolvedNotes,
    graph: buildGraph(resolvedNotes)
  };
}

export function searchNotes(index: VaultIndex, filters: SearchFilters): SearchResult[] {
  const query = filters.query.trim().toLowerCase();
  const tags = filters.tags ?? [];
  const frontmatter = filters.frontmatter ?? {};

  return index.notes
    .filter((note) => {
      const haystack = `${note.path}\n${note.title}\n${note.content}`.toLowerCase();
      const matchesText = !query || haystack.includes(query);
      const matchesTags = tags.every((tag) => note.tags.includes(tag));
      const matchesFrontmatter = Object.entries(frontmatter).every(([key, value]) => note.frontmatter[key] === value);
      return matchesText && matchesTags && matchesFrontmatter;
    })
    .map((note) => ({
      path: note.path,
      title: note.title,
      tags: note.tags,
      frontmatter: note.frontmatter,
      modifiedAt: note.modifiedAt,
      contentHash: note.contentHash,
      snippet: makeSnippet(note.content, query)
    }));
}

export function getNoteContext(index: VaultIndex, path: string): NoteContext {
  const note = index.notes.find((candidate) => candidate.path === path);
  if (!note) {
    throw new Error(`Note not found: ${path}`);
  }

  const backlinks = index.notes.flatMap((candidate) =>
    candidate.links.filter((link) => link.resolvedPath === path && candidate.path !== path)
  );

  return {
    note,
    backlinks,
    outgoingLinks: note.links
  };
}

function buildTargetResolver(notes: ParsedNote[]): Map<string, string> {
  const resolver = new Map<string, string>();
  for (const note of notes) {
    resolver.set(normalizeRef(note.path), note.path);
    resolver.set(normalizeRef(note.path.replace(/\.md$/i, "")), note.path);
    resolver.set(normalizeRef(note.title), note.path);
  }
  return resolver;
}

function buildGraph(notes: ParsedNote[]): GraphData {
  return {
    focusedPath: null,
    nodes: notes.map((note) => ({
      id: note.path,
      label: note.title,
      tags: note.tags
    })),
    edges: notes.flatMap((note) =>
      note.links
        .filter((link): link is NoteLink & { resolvedPath: string } => Boolean(link.resolvedPath))
        .map((link) => ({
          id: `${note.path}->${link.resolvedPath}->${link.line}`,
          source: note.path,
          target: link.resolvedPath,
          isManaged: link.isManaged
        }))
    )
  };
}

function normalizeRef(value: string): string {
  return value.replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
}

function makeSnippet(content: string, query: string): string {
  if (!query) {
    return content.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 140) ?? "";
  }

  const lower = content.toLowerCase();
  const index = lower.indexOf(query);
  if (index === -1) {
    return "";
  }

  const start = Math.max(0, index - 40);
  const end = Math.min(content.length, index + query.length + 80);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}
