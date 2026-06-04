import { describe, expect, it } from "vitest";
import { createMockVaultApi } from "../src/api/mockVault";

describe("mock vault entry mutations", () => {
  it("creates a note in the selected folder and indexes it", async () => {
    const api = createMockVaultApi();
    await api.openVault("Demo Vault");

    const result = await api.createNote("Projects", "New Idea");

    expect(result.selectedPath).toBe("Projects/New Idea.md");
    expect(result.vault.notes.map((note) => note.path)).toContain("Projects/New Idea.md");
    await expect(api.readNote("Projects/New Idea.md")).resolves.toMatchObject({
      path: "Projects/New Idea.md",
      content: "# New Idea\n"
    });
  });

  it("renames a note and keeps its content readable at the new path", async () => {
    const api = createMockVaultApi();
    await api.openVault("Demo Vault");

    const result = await api.renameEntry("Research/Markdown Systems.md", "Portable Links");

    expect(result.selectedPath).toBe("Research/Portable Links.md");
    await expect(api.readNote("Research/Portable Links.md")).resolves.toMatchObject({
      path: "Research/Portable Links.md"
    });
    await expect(api.readNote("Research/Markdown Systems.md")).rejects.toThrow("File not found");
  });

  it("deletes notes but refuses to delete non-empty folders", async () => {
    const api = createMockVaultApi();
    await api.openVault("Demo Vault");

    await expect(api.deleteEntry("Projects")).rejects.toThrow("Folder is not empty");
    const result = await api.deleteEntry("일지/한글 노트.md");

    expect(result.vault.notes.map((note) => note.path)).not.toContain("일지/한글 노트.md");
  });
});
