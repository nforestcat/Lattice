import { describe, expect, it } from "vitest";
import { buildVaultIndex } from "../src/core/indexer";
import { createContextBundle } from "../src/core/contextBundle";

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
});
