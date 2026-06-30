import { describe, expect, it } from "vitest";
import { stampAiProvenance } from "../src/core/provenance";
import type { AiProvenance } from "../src/api/types";

const baseProv: AiProvenance = {
  model: "test-model",
  source: "test",
  appliedAt: "2026-01-01T00:00:00Z",
};

function stampN(n: number, content = "# Note\n"): string {
  let result = content;
  for (let i = 0; i < n; i++) {
    result = stampAiProvenance(result, baseProv, `edit-${i}`);
  }
  return result;
}

function countAiEdits(content: string): number {
  return (content.match(/  - \{/g) || []).length;
}

describe("stampAiProvenance", () => {
  it("stamps a single edit into frontmatter", () => {
    const result = stampAiProvenance("# Note\n", baseProv, "e1");
    expect(result).toContain("ai_edits:");
    expect(result).toContain('"id":"e1"');
  });

  it("deduplicates by editId", () => {
    let content = stampAiProvenance("# Note\n", baseProv, "e1");
    content = stampAiProvenance(content, baseProv, "e1");
    expect(countAiEdits(content)).toBe(1);
  });

  it("caps ai_edits at 20 entries", () => {
    const result = stampN(25);
    expect(countAiEdits(result)).toBe(20);
    // oldest 5 dropped, newest retained
    expect(result).not.toContain('"id":"edit-0"');
    expect(result).not.toContain('"id":"edit-4"');
    expect(result).toContain('"id":"edit-5"');
    expect(result).toContain('"id":"edit-24"');
  });

  it("preserves dedup after cap", () => {
    let result = stampN(25);
    // re-stamping an existing id should be a no-op
    result = stampAiProvenance(result, baseProv, "edit-24");
    expect(countAiEdits(result)).toBe(20);
  });

  it("appends to existing frontmatter without touching other keys", () => {
    const content = "---\ntitle: Test\ntags: [a]\n---\n# Note\n";
    const result = stampAiProvenance(content, baseProv, "e1");
    expect(result).toContain("title: Test");
    expect(result).toContain("tags: [a]");
    expect(result).toContain('"id":"e1"');
  });
});
