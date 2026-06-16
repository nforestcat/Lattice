import type { MaintenanceSuggestionKind } from "../api/types";

export function buildMaintenancePrompt(
  suggestionKind: MaintenanceSuggestionKind,
  notePath: string,
  noteExcerpt: string,
  candidates: string[]
): string {
  const candidateList = candidates.map((c) => `- ${c}`).join("\n");

  switch (suggestionKind) {
    case "summary":
      return `Write a single concise sentence summarizing this note for use as its frontmatter summary field. Return only the sentence, no quotes or labels.\n\nNote: ${notePath}\n\n${noteExcerpt}`;

    case "split":
      return `This note is too long and covers too many topics. Suggest how to split it into 2–3 focused sub-notes. For each sub-note, provide a proposed title and a one-sentence description of what it would cover.\n\nNote: ${notePath}\n\n${noteExcerpt}`;

    case "link_candidates":
      return `Which of the following existing notes should add a [[wikilink]] pointing to "${notePath}"? Rank the top 3 candidates and give a one-line reason for each.\n\nCandidates:\n${candidateList}\n\nNote to link to: ${notePath}`;

    case "review_prompt":
      return `This note has not been updated recently. List 3 concrete, specific things that should be reviewed or updated in it. Be actionable.\n\nNote: ${notePath}\n\n${noteExcerpt}`;

    case "merge_or_delete":
      return `This note has duplicate content. Suggest whether to (a) merge it into another note (and which one), or (b) delete it. Give a brief rationale.\n\nNote: ${notePath}\n\n${noteExcerpt}`;

    case "backlinks_in":
      return `Which of the following existing notes should add a [[wikilink]] pointing to "${notePath}"? Rank the top 3 and give a one-line reason for each.\n\nCandidates:\n${candidateList}\n\nTarget note: ${notePath}`;
  }
}
