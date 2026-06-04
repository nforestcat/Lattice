import { describe, expect, it } from "vitest";
import { createMockVaultApi } from "../src/api/mockVault";
import { formatInboxCapture } from "../src/core/capture";

describe("formatInboxCapture", () => {
  it("formats captured text with timestamp, related note, inbox tag, and body", () => {
    const markdown = formatInboxCapture({
      content: "LLM answer worth keeping.",
      relatedTitle: "Project",
      capturedAt: new Date("2026-06-04T06:30:00.000Z")
    });

    expect(markdown).toBe([
      "## 2026-06-04 06:30",
      "",
      "Related: [[Project]]",
      "",
      "#inbox",
      "",
      "LLM answer worth keeping.",
      ""
    ].join("\n"));
  });
});

describe("mock vault capture", () => {
  it("appends captures to the daily inbox note and indexes the result", async () => {
    const api = createMockVaultApi();
    await api.openVault("Demo Vault");

    const result = await api.captureToInbox({
      content: "Turn this into a durable note later.",
      relatedPath: "Projects/Obsidian Replacement.md",
      capturedAt: "2026-06-04T06:30:00.000Z"
    });

    expect(result.selectedPath).toBe("Inbox/2026-06-04.md");
    expect(result.vault.notes.map((note) => note.path)).toContain("Inbox/2026-06-04.md");
    await expect(api.readNote("Inbox/2026-06-04.md")).resolves.toMatchObject({
      content: expect.stringContaining("Related: [[Obsidian Replacement]]")
    });
    const matches = await api.searchNotes({ query: "durable note", tags: ["inbox"] });
    expect(matches.map((note) => note.path)).toEqual(["Inbox/2026-06-04.md"]);
  });
});
