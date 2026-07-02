import type { ProposedEdit } from "../api/types";
import { computeInMemoryDiff, type DiffLine } from "./diff";

export type ProposedEditHunk = {
  readonly id: string;
  readonly lines: readonly DiffLine[];
  readonly removeCount: number;
  readonly addCount: number;
};

export type ProposedEditHunkSelection = {
  readonly editToApply: ProposedEdit;
  readonly remainingEdit: ProposedEdit | null;
  readonly selectedCount: number;
  readonly totalCount: number;
};

type DiffLineWithHunk = DiffLine & {
  readonly hunkId?: string;
};

function sourceText(edit: ProposedEdit): { readonly target: string; readonly replacement: string } | null {
  if (edit.type !== "update") return null;
  const target = edit.targetContent ?? "";
  const replacement = edit.replacementContent ?? "";
  if (target === "" || target === replacement) return null;
  return { target, replacement };
}

function annotatedDiff(edit: ProposedEdit): readonly DiffLineWithHunk[] {
  const text = sourceText(edit);
  if (text === null) return [];

  const annotated: DiffLineWithHunk[] = [];
  let hunkIndex = 0;
  let currentHunkId: string | null = null;
  for (const line of computeInMemoryDiff(text.target, text.replacement)) {
    if (line.type === "context") {
      currentHunkId = null;
      annotated.push(line);
      continue;
    }

    if (currentHunkId === null) {
      hunkIndex += 1;
      currentHunkId = `hunk-${hunkIndex}`;
    }
    annotated.push({ ...line, hunkId: currentHunkId });
  }
  return annotated;
}

function renderDiffLines(lines: readonly DiffLineWithHunk[], selectedHunkIds: ReadonlySet<string>): string {
  const output: string[] = [];
  for (const line of lines) {
    if (line.type === "context") {
      output.push(line.text);
      continue;
    }

    const selected = line.hunkId !== undefined && selectedHunkIds.has(line.hunkId);
    if ((selected && line.type === "add") || (!selected && line.type === "remove")) {
      output.push(line.text);
    }
  }
  return output.join("\n");
}

export function getSelectableProposedEditHunks(edit: ProposedEdit): readonly ProposedEditHunk[] {
  const hunks = new Map<string, DiffLine[]>();
  for (const line of annotatedDiff(edit)) {
    if (line.type === "context" || line.hunkId === undefined) continue;
    const lines = hunks.get(line.hunkId) ?? [];
    lines.push({ type: line.type, text: line.text });
    hunks.set(line.hunkId, lines);
  }

  return [...hunks.entries()].map(([id, lines]) => ({
    id,
    lines,
    removeCount: lines.filter((line) => line.type === "remove").length,
    addCount: lines.filter((line) => line.type === "add").length,
  }));
}

export function buildProposedEditHunkSelection(
  edit: ProposedEdit,
  hunkIds: readonly string[],
): ProposedEditHunkSelection | null {
  const text = sourceText(edit);
  if (text === null) return null;

  const hunks = getSelectableProposedEditHunks(edit);
  const validHunkIds = new Set(hunks.map((hunk) => hunk.id));
  const selectedHunkIds = new Set(hunkIds.filter((id) => validHunkIds.has(id)));
  if (selectedHunkIds.size === 0) return null;

  const lines = annotatedDiff(edit);
  const selectedReplacement = renderDiffLines(lines, selectedHunkIds);
  if (selectedReplacement === text.target) return null;

  const editToApply: ProposedEdit = {
    ...edit,
    targetContent: text.target,
    replacementContent: selectedReplacement,
  };
  const remainingEdit: ProposedEdit | null = selectedHunkIds.size === hunks.length
    ? null
    : {
        ...edit,
        targetContent: selectedReplacement,
        replacementContent: text.replacement,
        applied: false,
      };

  return {
    editToApply,
    remainingEdit,
    selectedCount: selectedHunkIds.size,
    totalCount: hunks.length,
  };
}
