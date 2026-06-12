import { describe, it, expect } from "vitest";
import { applyTagsToMarkdown, formatYamlTags } from "../ingestMarkdown";

describe("formatYamlTags", () => {
  it("formats tag array as YAML inline sequence", () => {
    expect(formatYamlTags(["a", "b", "c"])).toBe("[a, b, c]");
  });

  it("handles empty array", () => {
    expect(formatYamlTags([])).toBe("[]");
  });
});

describe("applyTagsToMarkdown", () => {
  const MD_WITH_FM = `---
tags: [old]
source: https://example.com
---

# Title`;

  const MD_NO_FM = `# Title\n\nContent here.`;

  it("replaces existing tags line in frontmatter", () => {
    const result = applyTagsToMarkdown(MD_WITH_FM, ["new", "tags"]);
    expect(result).toContain("tags: [new, tags]");
    expect(result).not.toContain("tags: [old]");
  });

  it("preserves other frontmatter fields", () => {
    const result = applyTagsToMarkdown(MD_WITH_FM, ["x"]);
    expect(result).toContain("source: https://example.com");
  });

  it("prepends frontmatter when none exists", () => {
    const result = applyTagsToMarkdown(MD_NO_FM, ["foo"]);
    expect(result).toMatch(/^---\ntags: \[foo\]\n---/);
    expect(result).toContain("# Title");
  });

  it("adds tags field when frontmatter exists without tags", () => {
    const md = `---\nsource: https://x.com\n---\n\n# T`;
    const result = applyTagsToMarkdown(md, ["bar"]);
    expect(result).toContain("tags: [bar]");
    expect(result).toContain("source: https://x.com");
  });
});
