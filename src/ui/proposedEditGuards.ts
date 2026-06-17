import type { NoteDocument, ProposedEdit } from "../api/types";

export type AmbiguousUpdateAnchor = {
  readonly path: string;
  readonly targetContent: string;
  readonly occurrences: number;
};

type ReadNote = (path: string) => Promise<Pick<NoteDocument, "content">>;

function countOccurrences(content: string, target: string): number {
  if (target.length === 0) {
    return 0;
  }

  let occurrences = 0;
  let position = 0;
  while ((position = content.indexOf(target, position)) !== -1) {
    occurrences += 1;
    position += target.length;
    if (occurrences > 1) {
      return occurrences;
    }
  }
  return occurrences;
}

export async function findAmbiguousUpdateAnchor(
  edits: readonly ProposedEdit[],
  readNote: ReadNote
): Promise<AmbiguousUpdateAnchor | null> {
  for (const edit of edits) {
    if (edit.type !== "update" || !edit.targetContent) {
      continue;
    }

    const doc = await readNote(edit.path);
    const occurrences = countOccurrences(doc.content, edit.targetContent);
    if (occurrences > 1) {
      return {
        path: edit.path,
        targetContent: edit.targetContent,
        occurrences,
      };
    }
  }

  return null;
}
