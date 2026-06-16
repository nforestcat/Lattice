import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultApi } from "../src/api";
import type { EntryMutationResult, NoteDocument, ProposedEdit, SaveResult, VaultSnapshot } from "../src/api/types";
import { applyProposedEditToVault } from "../src/ui/proposedEditApply";

function emptyVault(): VaultSnapshot {
  return {
    rootPath: "Test Vault",
    notes: [],
    tree: [],
  };
}

function mutationResult(selectedPath: string | null = null): EntryMutationResult {
  return {
    vault: emptyVault(),
    selectedPath,
  };
}

function saveResult(): SaveResult {
  return {
    saved: true,
    revision: "rev-next",
    conflict: false,
    snapshotId: null,
    gitCommit: null,
  };
}

function noteDocument(content: string, revision = "rev-current"): NoteDocument {
  return {
    path: "Notes/Target.md",
    content,
    revision,
  };
}

describe("applyProposedEditToVault", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves replacement dollar tokens when applying update edits", async () => {
    const edit = {
      id: "edit-update",
      type: "update",
      path: "Notes/Target.md",
      targetContent: "replace me",
      replacementContent: "literal $& $` $' $$",
      applied: false,
      provenance: { source: "chat", promptRunId: "run-1", model: "test-model" },
    } satisfies ProposedEdit;
    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue(noteDocument("before replace me after"));
    const saveNoteSpy = vi.spyOn(vaultApi, "saveNote").mockResolvedValue(saveResult());
    const appendAuditSpy = vi.spyOn(vaultApi, "appendAiAudit").mockResolvedValue(undefined);

    await applyProposedEditToVault(edit);

    expect(readNoteSpy).toHaveBeenCalledWith("Notes/Target.md");
    expect(saveNoteSpy).toHaveBeenCalledWith(
      "Notes/Target.md",
      expect.stringContaining("before literal $& $` $' $$ after"),
      "rev-current",
    );
    expect(appendAuditSpy).toHaveBeenCalledWith(expect.objectContaining({ editId: "edit-update", editType: "update" }));
  });

  it("rejects delete edits before deleting when the required delete audit cannot be written", async () => {
    const edit = {
      id: "edit-delete",
      type: "delete",
      path: "Notes/Remove.md",
      applied: false,
      provenance: { source: "chat", promptRunId: "run-1" },
    } satisfies ProposedEdit;
    const deleteEntrySpy = vi.spyOn(vaultApi, "deleteEntry").mockResolvedValue(mutationResult());
    const appendAuditSpy = vi.spyOn(vaultApi, "appendAiAudit").mockRejectedValue(new Error("disk full"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(applyProposedEditToVault(edit)).rejects.toThrow(
      "Failed to write required delete audit log for Notes/Remove.md",
    );

    expect(deleteEntrySpy).not.toHaveBeenCalled();
    expect(appendAuditSpy).toHaveBeenCalledWith(expect.objectContaining({ editId: "edit-delete", editType: "delete" }));
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[provenance] Failed to write required delete audit log; delete aborted:",
      expect.any(Error),
    );
  });

  it("creates the merge target when desktop readNote reports a missing file string", async () => {
    const edit = {
      id: "edit-merge",
      type: "merge",
      path: "Notes/Source.md",
      newPath: "Archive/Merged.md",
      content: "# Merged",
      applied: false,
      provenance: { source: "manual-paste", promptRunId: null },
    } satisfies ProposedEdit;
    vi.spyOn(vaultApi, "readNote").mockRejectedValue("The system cannot find the file specified. (os error 2)");
    const createNoteSpy = vi.spyOn(vaultApi, "createNote").mockResolvedValue(mutationResult("Archive/Merged.md"));
    const saveNoteSpy = vi.spyOn(vaultApi, "saveNote").mockResolvedValue(saveResult());
    const deleteEntrySpy = vi.spyOn(vaultApi, "deleteEntry").mockResolvedValue(mutationResult());
    const appendAuditSpy = vi.spyOn(vaultApi, "appendAiAudit").mockResolvedValue(undefined);

    const result = await applyProposedEditToVault(edit);

    expect(createNoteSpy).toHaveBeenCalledWith("Archive", "Merged");
    expect(saveNoteSpy).toHaveBeenCalledWith("Archive/Merged.md", expect.stringContaining("# Merged"), "");
    expect(deleteEntrySpy).toHaveBeenCalledWith("Notes/Source.md");
    expect(appendAuditSpy).toHaveBeenCalledWith(expect.objectContaining({ editType: "merge", path: "Archive/Merged.md" }));
    expect(appendAuditSpy).toHaveBeenCalledWith(expect.objectContaining({ editType: "delete", path: "Notes/Source.md" }));
    expect(result).toMatchObject({ applied: true, provenance: expect.objectContaining({ source: "manual-paste" }) });
  });

  it("does not create a merge target when readNote fails for a non-missing-file reason", async () => {
    const edit = {
      id: "edit-merge-permission",
      type: "merge",
      path: "Notes/Source.md",
      newPath: "Archive/Merged.md",
      content: "# Merged",
      applied: false,
    } satisfies ProposedEdit;
    vi.spyOn(vaultApi, "readNote").mockRejectedValue(new Error("Permission denied"));
    const createNoteSpy = vi.spyOn(vaultApi, "createNote").mockResolvedValue(mutationResult("Archive/Merged.md"));

    await expect(applyProposedEditToVault(edit)).rejects.toThrow("Permission denied");

    expect(createNoteSpy).not.toHaveBeenCalled();
  });

  it("rejects merge source deletion before deleting when the required delete audit cannot be written", async () => {
    const edit = {
      id: "edit-merge-audit-fails",
      type: "merge",
      path: "Notes/Source.md",
      newPath: "Archive/Merged.md",
      content: "# Merged",
      applied: false,
      provenance: { source: "manual-paste", promptRunId: null },
    } satisfies ProposedEdit;
    vi.spyOn(vaultApi, "readNote").mockResolvedValue(noteDocument("# Existing target", "rev-target"));
    vi.spyOn(vaultApi, "saveNote").mockResolvedValue(saveResult());
    const deleteEntrySpy = vi.spyOn(vaultApi, "deleteEntry").mockResolvedValue(mutationResult());
    const appendAuditSpy = vi
      .spyOn(vaultApi, "appendAiAudit")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("disk full"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(applyProposedEditToVault(edit)).rejects.toThrow(
      "Failed to write required delete audit log for Notes/Source.md",
    );

    expect(appendAuditSpy).toHaveBeenCalledWith(expect.objectContaining({ editType: "merge", path: "Archive/Merged.md" }));
    expect(appendAuditSpy).toHaveBeenCalledWith(expect.objectContaining({ editType: "delete", path: "Notes/Source.md" }));
    expect(deleteEntrySpy).not.toHaveBeenCalled();
  });
});
