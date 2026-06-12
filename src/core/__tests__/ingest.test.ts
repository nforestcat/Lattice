import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildIngestPrompt, ingestToNote } from "../ingest";
import type { IngestRaw, LlmConfig } from "../../api/types";

vi.mock("../../api/llm", () => ({
  sendChatMessage: vi.fn(),
}));

import { sendChatMessage } from "../../api/llm";
const mockSend = vi.mocked(sendChatMessage);

const RAW: IngestRaw = {
  sourceRef: "https://example.com/article",
  sourceType: "url",
  text: "Hello world".repeat(30),
  ingestDate: "2026-01-01",
};

const LLM: LlmConfig = { provider: "ollama", apiKey: "", model: "llama3", baseUrl: "http://localhost:11434" };

describe("buildIngestPrompt", () => {
  it("includes sourceRef in user message", () => {
    const msgs = buildIngestPrompt(RAW);
    const user = msgs.find((m) => m.role === "user")!;
    expect(user.content).toContain(RAW.sourceRef);
  });

  it("truncates long text to contextLimit", () => {
    const longRaw: IngestRaw = { ...RAW, text: "x".repeat(20_000) };
    const msgs = buildIngestPrompt(longRaw, 8000);
    const user = msgs.find((m) => m.role === "user")!;
    expect(user.content).toContain("[... truncated]");
    expect(user.content.length).toBeLessThan(12_000);
  });

  it("does not truncate text within limit", () => {
    const msgs = buildIngestPrompt(RAW, 8000);
    const user = msgs.find((m) => m.role === "user")!;
    expect(user.content).not.toContain("[... truncated]");
  });
});

describe("ingestToNote", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  const VALID_RESPONSE = `---
tags: [foo, bar]
source: https://example.com/article
---

# Article Title

## Summary
Short summary here.

## Details
More content here.`;

  it("parses title, tags, and markdown from LLM response", async () => {
    mockSend.mockResolvedValue(VALID_RESPONSE);
    const result = await ingestToNote(RAW, LLM);
    expect(result.title).toBe("Article Title");
    expect(result.tags).toEqual(["foo", "bar"]);
    expect(result.markdown).toContain("# Article Title");
  });

  it("injects ingest_date when missing from frontmatter", async () => {
    mockSend.mockResolvedValue(VALID_RESPONSE);
    const result = await ingestToNote(RAW, LLM);
    expect(result.markdown).toContain("ingest_date: 2026-01-01");
  });

  it("injects source when missing from frontmatter", async () => {
    const responseNoSource = VALID_RESPONSE.replace(/\nsource:.*/, "");
    mockSend.mockResolvedValue(responseNoSource);
    const result = await ingestToNote(RAW, LLM);
    expect(result.markdown).toContain("source:");
  });

  it("throws when text is too short", async () => {
    const shortRaw: IngestRaw = { ...RAW, text: "hi" };
    await expect(ingestToNote(shortRaw, LLM)).rejects.toThrow("Extraction too thin");
  });

  it("throws with provider name when LLM fails", async () => {
    mockSend.mockRejectedValue(new Error("connection refused"));
    await expect(ingestToNote(RAW, LLM)).rejects.toThrow("ollama did not respond");
  });

  it("throws on empty LLM response", async () => {
    mockSend.mockResolvedValue("   ");
    await expect(ingestToNote(RAW, LLM)).rejects.toThrow("returned an empty response");
  });
});
