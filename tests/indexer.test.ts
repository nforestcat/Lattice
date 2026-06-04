import { describe, expect, it } from "vitest";
import { buildVaultIndex, getNoteContext, searchNotes } from "../src/core/indexer";

describe("buildVaultIndex", () => {
  it("builds backlinks, outgoing links, tags, frontmatter, and graph edges", () => {
    const index = buildVaultIndex([
      {
        path: "Home.md",
        content: "---\nstatus: evergreen\n---\n# Home\n\n[[Project]] #root"
      },
      {
        path: "Project.md",
        content: "# Project\n\n[[Home]]"
      }
    ]);

    expect(getNoteContext(index, "Project.md").backlinks.map((link) => link.sourcePath)).toEqual(["Home.md"]);
    expect(getNoteContext(index, "Home.md").outgoingLinks.map((link) => link.resolvedPath)).toEqual(["Project.md"]);
    expect(index.graph.edges).toEqual([
      expect.objectContaining({ source: "Home.md", target: "Project.md" }),
      expect.objectContaining({ source: "Project.md", target: "Home.md" })
    ]);
  });
});

describe("searchNotes", () => {
  it("filters notes by text, tags, and frontmatter properties", () => {
    const index = buildVaultIndex([
      {
        path: "A.md",
        content: "---\nstatus: draft\n---\n# Alpha\n\nBody #idea"
      },
      {
        path: "B.md",
        content: "---\nstatus: done\n---\n# Beta\n\nOther #archive"
      }
    ]);

    expect(searchNotes(index, { query: "alpha", tags: ["idea"], frontmatter: { status: "draft" } }).map((note) => note.path)).toEqual(["A.md"]);
    expect(searchNotes(index, { query: "", tags: ["idea"], frontmatter: { status: "done" } })).toEqual([]);
  });
});
