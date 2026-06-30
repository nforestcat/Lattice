import { describe, expect, it, vi } from "vitest";
import { pruneRecommendedCandidates } from "../src/ui/contextPrune";
import type { ContextBundle, ContextBundleCandidate } from "../src/api/types";

const candidates: ContextBundleCandidate[] = [
  { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 50, selected: true, characterCount: 100 },
  { path: "Rec1.md", title: "Rec1", reason: "Recommended", reasonDetail: "Rec1 detail", score: 5, excerpt: "Rec1 excerpt", tokenEstimate: 30, selected: false, characterCount: 60 },
  { path: "Rec2.md", title: "Rec2", reason: "Recommended", reasonDetail: "Rec2 detail", score: 7, excerpt: "Rec2 excerpt", tokenEstimate: 40, selected: false, characterCount: 80 },
];

function bundleFor(selectedPaths: string[], estimatedTokens: number): ContextBundle {
  return {
    title: "Context Bundle: Home",
    focusPath: "Home.md",
    notePaths: selectedPaths,
    markdown: "Bundle Content",
    estimatedTokens,
  };
}

describe("pruneRecommendedCandidates", () => {
  it("prunes the lowest score recommended note until the bundle fits", async () => {
    const getContextBundle = vi.fn(async (_path: string, options: { selectedPaths: string[] }) => {
      const selected = options.selectedPaths;
      let tokens = 0;
      if (selected.includes("Home.md")) tokens += 50;
      if (selected.includes("Rec1.md")) tokens += 30;
      if (selected.includes("Rec2.md")) tokens += 40;
      return bundleFor(selected, tokens);
    });

    const result = await pruneRecommendedCandidates({
      activePath: "Home.md",
      selectedContextPaths: new Set(["Home.md", "Rec1.md", "Rec2.md"]),
      contextCandidates: candidates,
      contextLimit: 100,
      bundlePurpose: "Answer the user",
      bundleMode: "standard",
      bundlePreset: "ask",
      getContextBundle,
    });

    expect([...result.nextPaths].sort()).toEqual(["Home.md", "Rec2.md"]);
    expect(result.currentBundle.estimatedTokens).toBe(90);
    expect(result.status).toBe("Auto-pruned 1 recommended note(s) to fit under the limit (Final: 90 tokens).");
  });

  it("reports when pruning recommended notes still leaves the bundle over the limit", async () => {
    const getContextBundle = vi.fn(async (_path: string, options: { selectedPaths: string[] }) => {
      const selected = options.selectedPaths;
      return bundleFor(selected, selected.includes("Rec1.md") ? 160 : 130);
    });

    const result = await pruneRecommendedCandidates({
      activePath: "Home.md",
      selectedContextPaths: new Set(["Home.md", "Rec1.md"]),
      contextCandidates: candidates.slice(0, 2),
      contextLimit: 100,
      bundlePurpose: "Answer the user",
      bundleMode: "standard",
      bundlePreset: "ask",
      getContextBundle,
    });

    expect([...result.nextPaths]).toEqual(["Home.md"]);
    expect(result.currentBundle.estimatedTokens).toBe(130);
    expect(result.status).toBe("Auto-pruned 1 recommended note(s), but bundle still exceeds the limit (Final: 130 tokens).");
  });
});
