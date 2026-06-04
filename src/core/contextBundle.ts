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
};

export type ContextBundleCandidate = {
  path: string;
  title: string;
  reason: "Focus" | "Outgoing" | "Backlink";
  selected: boolean;
  characterCount: number;
};

type IncludedNote = {
  note: ParsedNote;
  reason: "Focus" | "Outgoing" | "Backlink";
};

export function createContextBundle(index: VaultIndex, focusPath: string, options: ContextBundleOptions = {}): ContextBundle {
  const candidates = getIncludedNotes(index, focusPath);
  const selected = options.selectedPaths ? new Set(options.selectedPaths) : null;
  const notes = selected ? candidates.filter((entry) => selected.has(entry.note.path)) : candidates;
  const focus = findNote(index, focusPath);
  if (!focus) {
    throw new Error(`Note not found: ${focusPath}`);
  }
  const title = `Context Bundle: ${focus.title}`;

  return {
    title,
    focusPath,
    notePaths: notes.map((entry) => entry.note.path),
    markdown: renderBundle(title, notes)
  };
}

export function getContextBundleCandidates(index: VaultIndex, focusPath: string): ContextBundleCandidate[] {
  return getIncludedNotes(index, focusPath).map(({ note, reason }) => ({
    path: note.path,
    title: note.title,
    reason,
    selected: true,
    characterCount: note.content.length
  }));
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

  return Array.from(included.values());
}

function findNote(index: VaultIndex, path: string): ParsedNote | null {
  return index.notes.find((note) => note.path === path) ?? null;
}

function renderBundle(title: string, notes: IncludedNote[]): string {
  const lines = [
    `# ${title}`,
    "",
    "## Included Notes",
    ...notes.map(({ note, reason }) => `- ${reason}: [[${note.title}]] (\`${note.path}\`)`),
    "",
    "## Instructions",
    "",
    "Use this bundle as local wiki context. Prefer cited note names when answering or proposing edits.",
    ""
  ];

  for (const { note } of notes) {
    lines.push(`## Note: ${note.title}`, "", `Path: \`${note.path}\``, "");
    if (Object.keys(note.frontmatter).length) {
      lines.push("Frontmatter:", "```yaml");
      for (const [key, value] of Object.entries(note.frontmatter)) {
        lines.push(`${key}: ${value}`);
      }
      lines.push("```", "");
    }
    lines.push(note.content.trim(), "");
  }

  return `${lines.join("\n").trim()}\n`;
}
