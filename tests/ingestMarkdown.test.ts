import { describe, expect, it } from "vitest";
import { applyTagsToMarkdown } from "../src/core/ingestMarkdown";

describe("applyTagsToMarkdown", () => {
  it("updates existing frontmatter tags when tags are edited", () => {
    const markdown = `---
tags: [old, stale]
source: https://example.com
---

# Example`;

    const result = applyTagsToMarkdown(markdown, ["new", "reviewed"]);

    expect(result).toContain("tags: [new, reviewed]");
    expect(result).not.toContain("tags: [old, stale]");
    expect(result).toContain("source: https://example.com");
  });

  it("adds tags to existing frontmatter when the tag line is missing", () => {
    const markdown = `---
source: report.pdf
---

# Report`;

    const result = applyTagsToMarkdown(markdown, ["pdf"]);

    expect(result).toContain("tags: [pdf]\nsource: report.pdf");
  });

  it("recognizes CRLF frontmatter instead of duplicating it", () => {
    const markdown = "---\r\ntags: [old]\r\n---\r\n\r\n# Windows";

    const result = applyTagsToMarkdown(markdown, ["windows"]);

    expect(result.match(/^---/g)?.length).toBe(1);
    expect(result).toContain("tags: [windows]");
  });
});
