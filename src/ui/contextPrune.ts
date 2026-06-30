import type { ContextBundle, ContextBundleCandidate } from "../api/types";
import type { PresetType } from "./hooks/contextShared";

export type PruneRecommendedCandidatesInput = {
  activePath: string;
  selectedContextPaths: ReadonlySet<string>;
  contextCandidates: readonly ContextBundleCandidate[];
  contextLimit: number;
  bundlePurpose: string;
  bundleMode: "short" | "standard" | "full";
  bundlePreset: PresetType;
  getContextBundle: (
    path: string,
    options: {
      selectedPaths: string[];
      purpose: string;
      mode: "short" | "standard" | "full";
      preset: PresetType;
    },
  ) => Promise<ContextBundle>;
};

export type PruneRecommendedCandidatesResult = {
  nextPaths: Set<string>;
  currentBundle: ContextBundle;
  status: string;
};

export async function pruneRecommendedCandidates(
  input: PruneRecommendedCandidatesInput,
): Promise<PruneRecommendedCandidatesResult> {
  const nextPaths = new Set(input.selectedContextPaths);
  const selectedNotes = input.contextCandidates.filter((candidate) => nextPaths.has(candidate.path));
  const recommendedSelected = selectedNotes
    .filter((candidate) => candidate.reason === "Recommended")
    .sort((a, b) => a.score - b.score);

  let prunedCount = 0;
  let currentBundle = await input.getContextBundle(input.activePath, {
    selectedPaths: Array.from(nextPaths),
    purpose: input.bundlePurpose,
    mode: input.bundleMode,
    preset: input.bundlePreset,
  });
  let currentTokens = currentBundle.estimatedTokens;

  for (const note of recommendedSelected) {
    if (currentTokens <= input.contextLimit) {
      break;
    }
    nextPaths.delete(note.path);
    prunedCount++;
    currentBundle = await input.getContextBundle(input.activePath, {
      selectedPaths: Array.from(nextPaths),
      purpose: input.bundlePurpose,
      mode: input.bundleMode,
      preset: input.bundlePreset,
    });
    currentTokens = currentBundle.estimatedTokens;
  }

  let status: string;
  if (prunedCount > 0 && currentTokens <= input.contextLimit) {
    status = `Auto-pruned ${prunedCount} recommended note(s) to fit under the limit (Final: ${currentTokens.toLocaleString()} tokens).`;
  } else if (prunedCount > 0) {
    status = `Auto-pruned ${prunedCount} recommended note(s), but bundle still exceeds the limit (Final: ${currentTokens.toLocaleString()} tokens).`;
  } else if (currentTokens > input.contextLimit) {
    status = "No recommended notes to prune; try Short mode or deselect required notes.";
  } else {
    status = "No recommended notes to prune or already under limit.";
  }

  return { nextPaths, currentBundle, status };
}
