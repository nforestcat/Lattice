import type { ContextBundleCandidate } from "../api/types";

export type CandidateSortKey = "score" | "title" | "reason";

export function getDisplayedContextCandidates(
  candidates: readonly ContextBundleCandidate[],
  selectedPaths: ReadonlySet<string>,
  sortBy: CandidateSortKey,
  filterBy: string,
): ContextBundleCandidate[] {
  let list = [...candidates];
  if (filterBy === "selected") {
    list = list.filter((candidate) => selectedPaths.has(candidate.path));
  } else if (filterBy !== "all") {
    list = list.filter((candidate) => candidate.reason.toLowerCase() === filterBy);
  }

  list.sort((a, b) => {
    if (sortBy === "score") {
      return b.score - a.score;
    }
    if (sortBy === "title") {
      return a.title.localeCompare(b.title);
    }
    if (sortBy === "reason") {
      const reasonOrder: Record<string, number> = {
        focus: 0,
        outgoing: 1,
        backlink: 2,
        recommended: 3,
      };
      const orderA = reasonOrder[a.reason.toLowerCase()] ?? 99;
      const orderB = reasonOrder[b.reason.toLowerCase()] ?? 99;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return b.score - a.score;
    }
    return 0;
  });

  return list;
}
