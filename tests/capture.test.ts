import { describe, expect, it } from "vitest";
import { createMockVaultApi } from "../src/api/mockVault";
import { formatInboxCapture, parseInboxCaptures } from "../src/core/capture";

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

describe("parseInboxCaptures", () => {
  it("finds unprocessed inbox capture blocks before the processed section", () => {
    const captures = parseInboxCaptures([
      "# 2026-06-04",
      "",
      "## 2026-06-04 06:30",
      "",
      "Related: [[Project]]",
      "",
      "#inbox",
      "",
      "First captured idea.",
      "",
      "## 2026-06-04 07:00",
      "",
      "#inbox",
      "",
      "Second captured idea.",
      "",
      "## Processed",
      "",
      "## 2026-06-04 05:00",
      "",
      "#inbox",
      "",
      "Already handled."
    ].join("\n"));

    expect(captures).toEqual([
      expect.objectContaining({
        id: "2026-06-04 06:30",
        title: "2026-06-04 06:30",
        relatedTitle: "Project",
        body: "First captured idea."
      }),
      expect.objectContaining({
        id: "2026-06-04 07:00",
        title: "2026-06-04 07:00",
        relatedTitle: null,
        body: "Second captured idea."
      })
    ]);
  });

  it("promotes a capture into a new note and moves it to processed", async () => {
    const api = createMockVaultApi();
    await api.openVault("Demo Vault");
    await api.captureToInbox({
      content: "Make this a real note.",
      relatedPath: "Home.md",
      capturedAt: "2026-06-04T06:30:00.000Z"
    });

    const captures = await api.getInboxCaptures("Inbox/2026-06-04.md");
    const result = await api.promoteInboxCapture({
      inboxPath: "Inbox/2026-06-04.md",
      captureId: captures[0].id,
      title: "Real Note"
    });

    expect(result.selectedPath).toBe("Real Note.md");
    await expect(api.readNote("Real Note.md")).resolves.toMatchObject({
      content: expect.stringContaining("Make this a real note.")
    });
    await expect(api.readNote("Inbox/2026-06-04.md")).resolves.toMatchObject({
      content: expect.stringContaining("## Processed")
    });
    await expect(api.getInboxCaptures("Inbox/2026-06-04.md")).resolves.toEqual([]);
  });

  it("appends a capture into an existing note and moves it to processed", async () => {
    const api = createMockVaultApi();
    await api.openVault("Demo Vault");
    await api.captureToInbox({
      content: "Add this text to the end of Home note.",
      relatedPath: "Home.md",
      capturedAt: "2026-06-04T06:30:00.000Z"
    });

    const captures = await api.getInboxCaptures("Inbox/2026-06-04.md");
    const result = await api.appendInboxCapture({
      inboxPath: "Inbox/2026-06-04.md",
      captureId: captures[0].id,
      targetPath: "Home.md"
    });

    expect(result.selectedPath).toBe("Home.md");
    await expect(api.readNote("Home.md")).resolves.toMatchObject({
      content: expect.stringContaining("### Appended Capture (2026-06-04 06:30)\n\nAdd this text to the end of Home note.")
    });
    await expect(api.readNote("Inbox/2026-06-04.md")).resolves.toMatchObject({
      content: expect.stringContaining("## Processed")
    });
    await expect(api.getInboxCaptures("Inbox/2026-06-04.md")).resolves.toEqual([]);
  });
});
