import { parseMarkdownNote } from "./markdown";
import { normalizeRef } from "./normalizeRef";
import type { GraphData, GraphEdge, GraphNode, NoteContext, NoteLink, ParsedNote, SearchFilters, SearchResult, VaultFile, VaultIndex } from "./types";

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

  const allBacklinks = index.notes.flatMap((candidate) =>
    candidate.links.filter((link) => link.resolvedPath === path && candidate.path !== path)
  );
  const seenSources = new Set<string>();
  const backlinks = allBacklinks.filter((link) => {
    if (seenSources.has(link.sourcePath)) return false;
    seenSources.add(link.sourcePath);
    return true;
  });

  return {
    note,
    backlinks,
    outgoingLinks: note.links
  };
}

function buildTargetResolver(notes: ParsedNote[]): Map<string, string> {
  const resolver = new Map<string, string>();
  const ambiguousTitles = new Set<string>();
  for (const note of notes) {
    resolver.set(normalizeRef(note.path), note.path);
    resolver.set(normalizeRef(note.path.replace(/\.md$/i, "")), note.path);
    const titleKey = normalizeRef(note.title);
    if (resolver.has(titleKey) && resolver.get(titleKey) !== note.path) {
      ambiguousTitles.add(titleKey);
    } else {
      resolver.set(titleKey, note.path);
    }
  }
  for (const titleKey of ambiguousTitles) {
    resolver.delete(titleKey);
  }
  return resolver;
}

function buildGraph(notes: ParsedNote[]): GraphData {
  const nodes: GraphNode[] = notes.map((note) => ({
    id: note.path,
    label: note.title,
    tags: note.tags,
    kind: "note" as const
  }));

  const edges: GraphEdge[] = [];
  const unresolvedTargets = new Map<string, string>(); // normalized -> original
  const seenUnresolvedEdges = new Set<string>(); // "source->target"

  for (const note of notes) {
    for (const link of note.links) {
      if (link.resolvedPath) {
        edges.push({
          id: `${note.path}->${link.resolvedPath}->${link.line}`,
          source: note.path,
          target: link.resolvedPath,
          isManaged: link.isManaged
        });
      } else {
        const targetRef = link.targetRef;
        const normalized = normalizeRef(targetRef).trim();
        const ghostId = `unresolved:${normalized}`;

        // Track unique unresolved targets, preserving the first display ref we see
        if (!unresolvedTargets.has(normalized)) {
          unresolvedTargets.set(normalized, targetRef);
        }

        // Deduplicate edges to unresolved targets per source/target pair
        const edgeKey = `${note.path}->${ghostId}`;
        if (!seenUnresolvedEdges.has(edgeKey)) {
          seenUnresolvedEdges.add(edgeKey);
          edges.push({
            id: edgeKey,
            source: note.path,
            target: ghostId,
            isManaged: link.isManaged
          });
        }
      }
    }
  }

  // Add ghost nodes to the nodes list
  for (const [normalized, original] of unresolvedTargets.entries()) {
    nodes.push({
      id: `unresolved:${normalized}`,
      label: original,
      tags: [],
      kind: "unresolved" as const
    });
  }

  return {
    focusedPath: null,
    nodes,
    edges
  };
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
