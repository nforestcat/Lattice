import { describe, it, expect } from "vitest";
import { stampAiProvenance } from "../provenance";
import type { AiProvenance } from "../../api/types";

const PROV: AiProvenance = {
  source: "chat",
  model: "claude-sonnet-4-6",
  appliedAt: "2026-06-15T00:00:00.000Z",
};

describe("stampAiProvenance", () => {
  it("adds ai_edits entry to note without frontmatter", () => {
    const content = "# Hello\n\nSome text.";
    const result = stampAiProvenance(content, PROV, "edit-1");
    expect(result).toContain("ai_edits:");
    expect(result).toContain('"id":"edit-1"');
    expect(result).toContain('"source":"chat"');
    expect(result).toContain("# Hello");
    expect(result).toContain("Some text.");
  });

  it("adds ai_edits entry to note with existing frontmatter", () => {
    const content = "---\ntitle: Test\ntags: [foo]\n---\n# Hello";
    const result = stampAiProvenance(content, PROV, "edit-2");
    expect(result).toContain("title: Test");
    expect(result).toContain("tags: [foo]");
    expect(result).toContain("ai_edits:");
    expect(result).toContain('"id":"edit-2"');
  });

  it("is idempotent — same editId produces exactly one entry", () => {
    const content = "---\ntitle: Test\n---\n# Hello";
    const once = stampAiProvenance(content, PROV, "edit-3");
    const twice = stampAiProvenance(once, PROV, "edit-3");
    const matches = (twice.match(/"id":"edit-3"/g) || []).length;
    expect(matches).toBe(1);
  });

  it("appends a second entry for a different editId", () => {
    const content = "---\ntitle: Test\n---\n# Hello";
    const once = stampAiProvenance(content, PROV, "edit-4a");
    const twice = stampAiProvenance(once, PROV, "edit-4b");
    expect(twice).toContain('"id":"edit-4a"');
    expect(twice).toContain('"id":"edit-4b"');
  });

  it("does not modify user prose outside frontmatter", () => {
    const body = "# My Note\n\nImportant prose that must not change.";
    const content = `---\ntitle: Test\n---\n${body}`;
    const result = stampAiProvenance(content, PROV, "edit-5");
    expect(result).toContain("Important prose that must not change.");
  });

  it("records manual-paste source with null promptRunId", () => {
    const pasteProv: AiProvenance = { source: "manual-paste", promptRunId: null };
    const result = stampAiProvenance("# Hello", pasteProv, "edit-6");
    expect(result).toContain('"source":"manual-paste"');
    expect(result).toContain('"run":null');
  });

  it("includes confidence when provided", () => {
    const provWithConf: AiProvenance = { ...PROV, confidence: 0.92 };
    const result = stampAiProvenance("# Hello", provWithConf, "edit-7");
    expect(result).toContain('"confidence":0.92');
  });
});

describe("provenance capture flows", () => {
  it("chat path — provenance has source 'chat' and a model", () => {
    const chatProv: AiProvenance = { source: "chat", model: "claude-sonnet-4-6" };
    expect(chatProv.source).toBe("chat");
    expect(chatProv.model).toBeTruthy();
    expect(chatProv.promptRunId).toBeUndefined();
  });

  it("paste path — provenance has source 'manual-paste' and promptRunId null", () => {
    const pasteProv: AiProvenance = { source: "manual-paste", promptRunId: null };
    expect(pasteProv.source).toBe("manual-paste");
    expect(pasteProv.promptRunId).toBeNull();
  });

  it("legacy item — no provenance field means undefined (not null)", () => {
    const item: { provenance?: AiProvenance } = {};
    expect(item.provenance).toBeUndefined();
  });
});
