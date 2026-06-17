import type { NoteHealthReport, ProposedEdit } from "../api/types";

export type RepairIssueType = "too_broad" | "orphan";

export interface RepairContext {
  notePath: string;
  noteContent: string;
  noteTitle: string;
  vaultTitles?: string[];
}

export interface DuplicatePeer {
  path: string;
  score: number;
  modifiedAt?: string;
}

// Shared propose_edit XML contract. Extracted here so chat and auditor use the same source of truth.
export const PROPOSE_EDIT_CONTRACT = `If you want to suggest modifications to notes, format your edits inside the response using this tag pattern:
<propose_edit type="create|update|merge|delete" path="relative/path/to/note.md" new_path="optional/new/path.md">
<reason>Explain why this edit is suggested.</reason>
<content><![CDATA[New content for create, or target replacement content details]]></content>
<target_content><![CDATA[Exact text to replace in update/merge]]></target_content>
<replacement_content><![CDATA[New replacement text in update/merge]]></replacement_content>
</propose_edit>
You can suggest multiple edits. Do not include markdown wraps around the tags.`;

const BASE_SYSTEM = `You are a knowledge-vault assistant. Your job is to propose structured edits to improve a Markdown note vault.\n\n${PROPOSE_EDIT_CONTRACT}`;

export function buildRepairPrompt(
  issue: RepairIssueType,
  ctx: RepairContext
): { system: string; user: string } {
  const { notePath, noteContent, noteTitle, vaultTitles } = ctx;

  if (issue === "too_broad") {
    const system = `${BASE_SYSTEM}

Rules for splitting a broad note:
- Produce 2 to 3 type="create" edits, each containing a focused child note with a distinct sub-topic extracted from the original.
- Also produce one type="update" edit on the original parent note replacing each migrated section with a [[wikilink]] to the corresponding new child note.
- The type="update" anchor (target_content) MUST be a verbatim substring that appears EXACTLY ONCE in the note. Choose a unique heading or the first sentence of the section being replaced.
- Child note paths must be relative to the vault root (e.g. "subfolder/child-topic.md").
- Do not fabricate content; only reorganise what is already in the note.`;

    const user = `The following note is flagged as TOO BROAD (over 5000 characters). Split it into 2–3 focused child notes and update the parent with wikilinks.

Note path: ${notePath}
Note title: ${noteTitle}

--- NOTE CONTENT ---
${noteContent}
--- END ---

Propose the split using the tag format above.`;

    return { system, user };
  }

  // orphan
  const titlesSection =
    vaultTitles && vaultTitles.length > 0
      ? `\n\nAvailable notes in the vault (titles):\n${vaultTitles.map((t) => `- ${t}`).join("\n")}`
      : "";

  const system = `${BASE_SYSTEM}

Rules for fixing an orphan note:
- Produce exactly one type="update" edit that adds a short "See also:" or "Related:" section to the note listing 1–3 genuinely related notes from the vault.
- Only reference notes from the provided vault title list. Do not invent note titles.
- The anchor (target_content) MUST be a verbatim substring that appears EXACTLY ONCE in the note. Prefer the final heading or the last paragraph.
- Keep the addition minimal — a brief section with [[wikilinks]].`;

  const user = `The following note is flagged as an ORPHAN (no other notes link to it). Add a backlink section so the note becomes discoverable.

Note path: ${notePath}
Note title: ${noteTitle}${titlesSection}

--- NOTE CONTENT ---
${noteContent}
--- END ---

Propose a "See also" or "Related" addition using the tag format above.`;

  return { system, user };
}

function generateId(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2, 11);
}

/**
 * Returns which path survives a deterministic duplicate merge.
 * Higher score wins; equal scores fall back to lexicographically smaller path.
 * (NoteHealthReport does not expose the report note's own modifiedAt, so date
 * comparison is not available as a tiebreak.)
 */
export function selectSurvivorPath(
  report: NoteHealthReport,
  peer: DuplicatePeer
): string {
  if (report.score !== peer.score) {
    return report.score > peer.score ? report.path : peer.path;
  }
  return report.path < peer.path ? report.path : peer.path;
}

/**
 * Builds a deterministic merge ProposedEdit for an exact-duplicate note pair.
 * No LLM call required — detection is byte-identical so no synthesis is needed.
 *
 * Field mapping (matches applyProposedEditToVault semantics):
 *   path    = loser  (deleted by apply)
 *   newPath = survivor (kept, content written)
 *   content = survivorContent (must be non-empty; apply overwrites newPath with this)
 */
export function buildDeterministicMergeEdit(
  report: NoteHealthReport,
  peer: DuplicatePeer,
  survivorContent: string
): ProposedEdit {
  const survivorPath = selectSurvivorPath(report, peer);
  const loserPath = survivorPath === report.path ? peer.path : report.path;

  return {
    id: generateId(),
    type: "merge",
    path: loserPath,
    newPath: survivorPath,
    content: survivorContent,
    reason: `Exact duplicate of ${survivorPath}. Keeping the higher-scored copy (score ${report.score} vs ${peer.score}).`,
    applied: false,
    checked: true,
  };
}
