import { describe, expect, it } from "vitest";
import { buildVaultIndex } from "../src/core/indexer";
import { createContextBundle, getContextBundleCandidates, estimateTokens } from "../src/core/contextBundle";

describe("createContextBundle", () => {
  it("bundles the focus note with outgoing links and backlinks for LLM context", () => {
    const index = buildVaultIndex([
      {
        path: "Home.md",
        content: "# Home\n\nLinks to [[Project]]."
      },
      {
        path: "Project.md",
        content: "---\nstatus: draft\n---\n# Project\n\nBuild LLM wiki tooling. [[Research]] #llm"
      },
      {
        path: "Research.md",
        content: "# Research\n\nBackground material."
      }
    ]);

    const bundle = createContextBundle(index, "Project.md");

    expect(bundle.title).toBe("Context Bundle: Project");
    expect(bundle.notePaths).toEqual(["Project.md", "Research.md", "Home.md"]);
    expect(bundle.markdown).toContain("# Context Bundle: Project");
    expect(bundle.markdown).toContain("## Included Notes");
    expect(bundle.markdown).toContain("- Focus: [[Project]] (`Project.md`)");
    expect(bundle.markdown).toContain("- Outgoing: [[Research]] (`Research.md`)");
    expect(bundle.markdown).toContain("- Backlink: [[Home]] (`Home.md`)");
    expect(bundle.markdown).toContain("## Note: Project");
    expect(bundle.markdown).toContain("status: draft");
    expect(bundle.markdown).toContain("Build LLM wiki tooling.");
    expect(bundle.estimatedTokens).toBeGreaterThan(0);
  });

  it("deduplicates notes that are both backlinks and outgoing links", () => {
    const index = buildVaultIndex([
      { path: "A.md", content: "# A\n\n[[B]]" },
      { path: "B.md", content: "# B\n\n[[A]]" }
    ]);

    const bundle = createContextBundle(index, "A.md");

    expect(bundle.notePaths).toEqual(["A.md", "B.md"]);
    expect(bundle.markdown.match(/## Note: B/g)).toHaveLength(1);
  });

  it("bundles only selected candidate paths when a builder selection is provided", () => {
    const index = buildVaultIndex([
      { path: "Home.md", content: "# Home\n\nLinks to [[Project]]." },
      { path: "Project.md", content: "# Project\n\n[[Research]] and [[Archive]]." },
      { path: "Research.md", content: "# Research\n\nUseful source." },
      { path: "Archive.md", content: "# Archive\n\nToo noisy." }
    ]);

    const bundle = createContextBundle(index, "Project.md", {
      selectedPaths: ["Project.md", "Home.md"]
    });

    expect(bundle.notePaths).toEqual(["Project.md", "Home.md"]);
    expect(bundle.markdown).toContain("## Note: Project");
    expect(bundle.markdown).toContain("## Note: Home");
    expect(bundle.markdown).not.toContain("## Note: Research");
    expect(bundle.markdown).not.toContain("## Note: Archive");
  });

  it("lists selectable context bundle candidates with reasons", () => {
    const index = buildVaultIndex([
      { path: "Home.md", content: "# Home\n\nLinks to [[Project]]." },
      { path: "Project.md", content: "# Project\n\n[[Research]]" },
      { path: "Research.md", content: "# Research\n\nUseful source." }
    ]);

    const candidates = getContextBundleCandidates(index, "Project.md");

    expect(candidates).toEqual([
      expect.objectContaining({ path: "Project.md", title: "Project", reason: "Focus", selected: true }),
      expect.objectContaining({ path: "Research.md", title: "Research", reason: "Outgoing", selected: true }),
      expect.objectContaining({ path: "Home.md", title: "Home", reason: "Backlink", selected: true })
    ]);
    expect(candidates.map((candidate) => candidate.characterCount)).toEqual([23, 26, 29]);
  });

  it("includes the mode and purpose in the bundle headers", () => {
    const index = buildVaultIndex([
      { path: "Home.md", content: "# Home\n\nSome body content." }
    ]);

    const bundle = createContextBundle(index, "Home.md", {
      purpose: "Testing purpose field",
      mode: "short"
    });

    expect(bundle.markdown).toContain("**Mode**: Short");
    expect(bundle.markdown).toContain("**Purpose**: Testing purpose field");
  });

  it("includes the preset in the bundle headers if a non-custom preset is specified", () => {
    const index = buildVaultIndex([
      { path: "Home.md", content: "# Home\n\nSome body content." }
    ]);

    const bundle = createContextBundle(index, "Home.md", {
      purpose: "Review code structure, propose refactorings, or suggest quality improvements.",
      mode: "full",
      preset: "refactor"
    });

    expect(bundle.markdown).toContain("**Preset**: Refactor");
    expect(bundle.markdown).toContain("**Mode**: Full");
    expect(bundle.markdown).toContain("**Purpose**: Review code structure, propose refactorings, or suggest quality improvements.");
  });

  it("extracts a clean excerpt for Short mode", () => {
    const index = buildVaultIndex([
      {
        path: "Home.md",
        content: "---\nstatus: active\n---\n# Home\n\nThis is a long body content that we want to verify gets truncated in short mode. It has multiple lines and we want a clean excerpt."
      }
    ]);

    const bundle = createContextBundle(index, "Home.md", {
      mode: "short"
    });

    expect(bundle.markdown).toContain("**Mode**: Short");
    expect(bundle.markdown).toContain("Frontmatter:");
    expect(bundle.markdown).toContain("status: active");
    expect(bundle.markdown).toContain("This is a long body content that we want to verify gets truncated");
    expect(bundle.markdown).not.toContain("# Home");
  });

  it("includes outgoing and backlinks summaries in Full mode", () => {
    const index = buildVaultIndex([
      { path: "Home.md", content: "# Home\n\nLinks to [[Project]]." },
      { path: "Project.md", content: "# Project\n\n[[Research]]." },
      { path: "Research.md", content: "# Research" }
    ]);

    const bundle = createContextBundle(index, "Project.md", {
      mode: "full"
    });

    expect(bundle.markdown).toContain("**Mode**: Full");
    expect(bundle.markdown).toContain("### Links");
    expect(bundle.markdown).toContain("- **Outgoing**:");
    expect(bundle.markdown).toContain("  - [[Research]] (`Research.md`)");
    expect(bundle.markdown).toContain("- **Backlinks**:");
    expect(bundle.markdown).toContain("  - [[Home]] (`Home.md`)");
  });

  it("lists recommended context bundle candidates (by shared tags or unlinked mentions) as unselected by default", () => {
    const index = buildVaultIndex([
      { path: "Home.md", content: "# Home\n\nNo links here. Mentions target Project in plain text. #general" },
      { path: "Project.md", content: "# Project\n\nTesting candidates. #general" },
      { path: "Unrelated.md", content: "# Unrelated\n\nNo tag matches, no mentions." }
    ]);

    const candidates = getContextBundleCandidates(index, "Project.md");

    expect(candidates).toEqual([
      expect.objectContaining({ path: "Project.md", title: "Project", reason: "Focus", selected: true }),
      expect.objectContaining({ path: "Home.md", title: "Home", reason: "Recommended", selected: false })
    ]);
    expect(candidates.find((candidate) => candidate.path === "Unrelated.md")).toBeUndefined();
  });

  it("recommends notes that mention the focus title even when the focus does not mention them", () => {
    const index = buildVaultIndex([
      { path: "Project.md", content: "# Project\n\nFocus note without outgoing links." },
      { path: "Meeting.md", content: "# Meeting\n\nWe discussed Project in plain text." },
      { path: "Other.md", content: "# Other\n\nNo mention here." }
    ]);

    const candidates = getContextBundleCandidates(index, "Project.md");

    expect(candidates).toEqual([
      expect.objectContaining({ path: "Project.md", reason: "Focus", selected: true }),
      expect.objectContaining({ path: "Meeting.md", reason: "Recommended", selected: false })
    ]);
  });

  it("detects a later valid title mention even if an earlier occurrence is inside another word", () => {
    const index = buildVaultIndex([
      { path: "AI.md", content: "# AI\n\nFocus note." },
      { path: "Research.md", content: "# Research\n\nAIM is not a title mention, but AI is." }
    ]);

    const candidates = getContextBundleCandidates(index, "AI.md");

    expect(candidates.map((candidate) => candidate.path)).toEqual(["AI.md", "Research.md"]);
  });

  it("populates detailed scores, reasonDetails, and snippets (excerpts) for candidates", () => {
    const index = buildVaultIndex([
      { path: "Project.md", content: "# Project\n\nTesting candidates. [[Research]] #llm" },
      { path: "Research.md", content: "# Research\n\nBackground information for project." },
      { path: "Home.md", content: "# Home\n\nLinked to Project. #llm" }
    ]);

    const candidates = getContextBundleCandidates(index, "Project.md");

    // Focus candidate
    const focus = candidates.find(c => c.path === "Project.md");
    expect(focus).toBeDefined();
    expect(focus!.score).toBe(10.0);
    expect(focus!.reasonDetail).toBe("Focus note");
    expect(focus!.excerpt).toContain("Testing candidates.");
    expect(focus!.tokenEstimate).toBe(estimateTokens("# Project\n\nTesting candidates. [[Research]] #llm"));

    // Outgoing candidate
    const outgoing = candidates.find(c => c.path === "Research.md");
    expect(outgoing).toBeDefined();
    expect(outgoing!.score).toBe(8.0);
    expect(outgoing!.reasonDetail).toBe("Direct link inside the focus note");
    expect(outgoing!.excerpt).toContain("Background information");

    // Recommended candidate (shares tag #llm & mentions focus)
    const recommended = candidates.find(c => c.path === "Home.md");
    expect(recommended).toBeDefined();
    expect(recommended!.score).toBe(9.5);
    expect(recommended!.reasonDetail).toBe("Shares tags: #llm; mentions focus 1 time(s)");
  });

  describe("estimateTokens", () => {
    it("estimates token counts for English text correctly", () => {
      expect(estimateTokens("Hello World")).toBe(3); // 11 chars / 4 = 2.75 -> 3
    });

    it("estimates token counts for Korean CJK text correctly", () => {
      expect(estimateTokens("한글")).toBe(3); // 2 chars * 1.2 = 2.4 -> 3
    });

    it("estimates token counts for mixed text correctly", () => {
      expect(estimateTokens("Hello 한글")).toBe(4); // 6 / 4 + 2 * 1.2 = 1.5 + 2.4 = 3.9 -> 4
    });
  });
});
