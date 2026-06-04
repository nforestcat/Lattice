import { describe, expect, it } from "vitest";
import { addManagedLink, parseMarkdownNote, removeManagedLink } from "../src/core/markdown";

describe("parseMarkdownNote", () => {
  it("extracts frontmatter, title, tags, Korean filenames, and wiki links", () => {
    const note = parseMarkdownNote("노트/생각.md", `---
status: draft
area: research
---
# 생각 정리

This links to [[다른 노트]] and [[Folder/Target|target alias]].
#idea #프로젝트/위키
`);

    expect(note.path).toBe("노트/생각.md");
    expect(note.title).toBe("생각 정리");
    expect(note.frontmatter).toEqual({ status: "draft", area: "research" });
    expect(note.tags).toEqual(["idea", "프로젝트/위키"]);
    expect(note.links.map((link) => link.targetRef)).toEqual(["다른 노트", "Folder/Target"]);
  });

  it("marks links inside the managed Links section without marking manual body links", () => {
    const note = parseMarkdownNote("source.md", `Manual [[Target]]

## Links

- [[Target]]
- [[Other]]
`);

    expect(note.links).toEqual([
      expect.objectContaining({ targetRef: "Target", isManaged: false }),
      expect.objectContaining({ targetRef: "Target", isManaged: true }),
      expect.objectContaining({ targetRef: "Other", isManaged: true })
    ]);
  });
});

describe("managed graph links", () => {
  it("adds graph links to a predictable managed Links section", () => {
    const content = addManagedLink("# Source\n\nBody", "Target");

    expect(content).toBe("# Source\n\nBody\n\n## Links\n\n- [[Target]]\n");
  });

  it("does not duplicate existing managed graph links", () => {
    const content = addManagedLink("## Links\n\n- [[Target]]\n", "Target");

    expect(content).toBe("## Links\n\n- [[Target]]\n");
  });

  it("removes only app-managed links and preserves body links", () => {
    const content = removeManagedLink("Body [[Target]]\n\n## Links\n\n- [[Target]]\n- [[Other]]\n", "Target");

    expect(content).toBe("Body [[Target]]\n\n## Links\n\n- [[Other]]\n");
  });
});
