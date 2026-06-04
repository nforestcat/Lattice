import { getNoteContext } from "./indexer";
import type { ParsedNote, VaultIndex } from "./types";

export type ContextBundle = {
  title: string;
  focusPath: string;
  notePaths: string[];
  markdown: string;
};

type IncludedNote = {
  note: ParsedNote;
  reason: "Focus" | "Outgoing" | "Backlink";
};

export function createContextBundle(index: VaultIndex, focusPath: string): ContextBundle {
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

  const notes = Array.from(included.values());
  const title = `Context Bundle: ${context.note.title}`;

  return {
    title,
    focusPath,
    notePaths: notes.map((entry) => entry.note.path),
    markdown: renderBundle(title, notes)
  };
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
