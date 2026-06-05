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
});
