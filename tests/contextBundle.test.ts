import { describe, expect, it } from "vitest";
import { buildVaultIndex } from "../src/core/indexer";
import { createContextBundle, getContextBundleCandidates } from "../src/core/contextBundle";

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
});
