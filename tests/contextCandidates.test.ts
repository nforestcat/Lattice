import { describe, expect, it } from "vitest";
import { getDisplayedContextCandidates } from "../src/ui/contextCandidates";
import type { ContextBundleCandidate } from "../src/api/types";

const candidates: ContextBundleCandidate[] = [
  { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 50, selected: true, characterCount: 100 },
  { path: "RecB.md", title: "RecB", reason: "Recommended", reasonDetail: "RecB detail", score: 8, excerpt: "RecB excerpt", tokenEstimate: 30, selected: false, characterCount: 60 },
  { path: "RecA.md", title: "RecA", reason: "Recommended", reasonDetail: "RecA detail", score: 5, excerpt: "RecA excerpt", tokenEstimate: 40, selected: false, characterCount: 80 },
];

describe("getDisplayedContextCandidates", () => {
  it("sorts by score descending by default", () => {
    const result = getDisplayedContextCandidates(candidates, new Set(), "score", "all");

    expect(result.map((candidate) => candidate.title)).toEqual(["Home", "RecB", "RecA"]);
  });

  it("filters by connection type and sorts by title", () => {
    const result = getDisplayedContextCandidates(candidates, new Set(), "title", "recommended");

    expect(result.map((candidate) => candidate.title)).toEqual(["RecA", "RecB"]);
  });

  it("filters to selected paths", () => {
    const result = getDisplayedContextCandidates(candidates, new Set(["RecB.md"]), "score", "selected");

    expect(result.map((candidate) => candidate.title)).toEqual(["RecB"]);
  });
});
