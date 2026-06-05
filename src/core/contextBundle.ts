import { getNoteContext } from "./indexer";
import type { ParsedNote, VaultIndex } from "./types";

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
  selected: boolean;
  characterCount: number;
};

type IncludedNote = {
  note: ParsedNote;
  reason: "Focus" | "Outgoing" | "Backlink" | "Recommended";
};

export function extractExcerpt(content: string, length = 150): string {
  let body = content;
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) {
      body = content.slice(end + 4);
    }
  }
  // Remove title heading (# Heading)
  body = body.replace(/^#\s+.+$/m, "");

  // Clean up whitespace/multiple newlines
  const text = body.replace(/\s+/g, " ").trim();

  if (text.length <= length) {
    return text;
  }
  return text.slice(0, length) + "...";
}

export function createContextBundle(index: VaultIndex, focusPath: string, options: ContextBundleOptions = {}): ContextBundle {
  const candidates = getIncludedNotes(index, focusPath);
  const selected = options.selectedPaths ? new Set(options.selectedPaths) : null;
  const notes = selected ? candidates.filter((entry) => selected.has(entry.note.path)) : candidates;
  const focus = findNote(index, focusPath);
  if (!focus) {
    throw new Error(`Note not found: ${focusPath}`);
  }
  const title = `Context Bundle: ${focus.title}`;
  const mode = options.mode || "standard";
  const purpose = options.purpose;

  return {
    title,
    focusPath,
    notePaths: notes.map((entry) => entry.note.path),
    markdown: renderBundle(title, notes, purpose, mode, index)
  };
}

export function getContextBundleCandidates(index: VaultIndex, focusPath: string): ContextBundleCandidate[] {
  return getIncludedNotes(index, focusPath).map(({ note, reason }) => ({
    path: note.path,
    title: note.title,
    reason,
    selected: reason !== "Recommended",
    characterCount: note.content.length
  }));
}

function stripFrontmatter(content: string): string {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) {
      return content.slice(end + 4);
    }
  }
  return content;
}

export function isTitleMentioned(content: string, title: string): boolean {
  const stripped = stripFrontmatter(content);
  const index = stripped.toLowerCase().indexOf(title.toLowerCase());
  if (index === -1) {
    return false;
  }
  
  // Check char before
  if (index > 0) {
    const charBefore = stripped.charAt(index - 1);
    if (/[\p{L}\p{N}]/u.test(charBefore)) {
      return false;
    }
  }
  // Check char after
  const afterIndex = index + title.length;
  if (afterIndex < stripped.length) {
    const charAfter = stripped.charAt(afterIndex);
    if (/[\p{L}\p{N}]/u.test(charAfter)) {
      return false;
    }
  }
  return true;
}

function getIncludedNotes(index: VaultIndex, focusPath: string): IncludedNote[] {
  const context = getNoteContext(index, focusPath);
  const included = new Map<string, IncludedNote>();

  included.set(context.note.path, { note: context.note, reason: "Focus" });

  for (const link of context.outgoingLinks) {
    const note = link.resolvedPath ? findNote(index, link.resolvedPath) : null;
    if (note && !included.has(note.path)) {
      included.set(note.path, { note, reason: "Outgoing" });
    }
  }

  for (const link of context.backlinks) {
    const note = findNote(index, link.sourcePath);
    if (note && !included.has(note.path)) {
      included.set(note.path, { note, reason: "Backlink" });
    }
  }

  // Recommended related notes
  const focusNote = context.note;
  const focusTags = new Set(focusNote.tags);

  for (const note of index.notes) {
    if (included.has(note.path)) {
      continue;
    }

    const hasSharedTags = note.tags.some(tag => focusTags.has(tag));
    const isMentioned = isTitleMentioned(focusNote.content, note.title);

    if (hasSharedTags || isMentioned) {
      included.set(note.path, { note, reason: "Recommended" });
    }
  }

  return Array.from(included.values());
}

function findNote(index: VaultIndex, path: string): ParsedNote | null {
  return index.notes.find((note) => note.path === path) ?? null;
}

function renderBundle(
  title: string,
  notes: IncludedNote[],
  purpose?: string,
  mode: "short" | "standard" | "full" = "standard",
  index?: VaultIndex
): string {
  const headerLines = [
    `# ${title}`,
    "",
    `**Mode**: ${mode.charAt(0).toUpperCase() + mode.slice(1)}`
  ];

  if (purpose && purpose.trim()) {
    headerLines.push(`**Purpose**: ${purpose.trim()}`);
  }

  headerLines.push(
    "",
    "## Instructions",
    "",
    "Use this bundle as local wiki context. Prefer cited note names when answering or proposing edits.",
    "",
    "## Included Notes",
    ...notes.map(({ note, reason }) => `- ${reason}: [[${note.title}]] (\`${note.path}\`)`),
    ""
  );

  const bodyLines: string[] = [];
  for (const { note } of notes) {
    bodyLines.push(`## Note: ${note.title}`, "", `Path: \`${note.path}\``, "");
    if (Object.keys(note.frontmatter).length) {
      bodyLines.push("Frontmatter:", "```yaml");
      for (const [key, value] of Object.entries(note.frontmatter)) {
        bodyLines.push(`${key}: ${value}`);
      }
      bodyLines.push("```", "");
    }

    if (mode === "short") {
      bodyLines.push(extractExcerpt(note.content), "");
    } else {
      bodyLines.push(note.content.trim(), "");
    }

    if (mode === "full" && index) {
      const context = getNoteContext(index, note.path);
      const findNoteTitle = (path: string) => {
        const n = index.notes.find(candidate => candidate.path === path);
        return n ? n.title : path.split(/[\\/]/).pop()?.replace(/\.md$/i, "") ?? path;
      };

      const outgoingLinks = context.outgoingLinks.map(link => {
        const t = link.resolvedPath ? findNoteTitle(link.resolvedPath) : link.targetRef;
        return `  - [[${t}]]${link.resolvedPath ? ` (\`${link.resolvedPath}\`)` : ""}`;
      });

      const backlinks = context.backlinks.map(link => {
        const t = findNoteTitle(link.sourcePath);
        return `  - [[${t}]] (\`${link.sourcePath}\`)`;
      });

      bodyLines.push(
        "### Links",
        "- **Outgoing**:",
        ...(outgoingLinks.length ? outgoingLinks : ["  - None"]),
        "- **Backlinks**:",
        ...(backlinks.length ? backlinks : ["  - None"]),
        ""
      );
    }
  }

  return `${[...headerLines, ...bodyLines].join("\n").trim()}\n`;
}
