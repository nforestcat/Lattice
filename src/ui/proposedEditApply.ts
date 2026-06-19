import { vaultApi } from "../api";
import type { AiAuditRecord, ProposedEdit } from "../api/types";
import { stampAiProvenance } from "../core/provenance";

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return null;
}

function isMissingNoteReadError(error: unknown): boolean {
  const message = errorMessage(error)?.toLowerCase();
  if (message === undefined) return false;
  return (
    message.includes("not found") ||
    message.includes("cannot find the file") ||
    message.includes("no such file or directory") ||
    message.includes("os error 2")
  );
}

function rethrowReadNoteError(error: unknown): never {
  if (error instanceof Error) throw error;
  const message = errorMessage(error) ?? "Unknown note read failure";
  throw new Error(message);
}

function requiredAuditError(type: ProposedEdit["type"], path: string, cause: unknown): Error {
  return new Error(`Failed to write required ${type} audit log for ${path}`, { cause });
}

export async function applyProposedEditToVault(edit: ProposedEdit): Promise<ProposedEdit> {
  const appliedAt = new Date().toISOString();
  const baseProvenance = edit.provenance
    ? { ...edit.provenance, appliedAt }
    : { source: "unknown", appliedAt };

  async function appendAudit(
    type: ProposedEdit["type"],
    path: string,
    options: { readonly required?: boolean } = {},
  ): Promise<void> {
    const record: AiAuditRecord = {
      editId: edit.id,
      editType: type,
      path,
      promptRunId: edit.provenance?.promptRunId,
      model: edit.provenance?.model,
      source: edit.provenance?.source ?? "unknown",
      appliedAt,
      confidence: edit.provenance?.confidence,
    };
    try {
      await vaultApi.appendAiAudit(record);
    } catch (err) {
      if (options.required === true) {
        console.error("[provenance] Failed to write required delete audit log; delete aborted:", err);
        throw requiredAuditError(type, path, err);
      } else {
        console.warn("[provenance] Failed to write audit log (non-fatal):", err);
      }
    }
  }

  switch (edit.type) {
    case "create": {
      const pathParts = edit.path.split("/");
      const title = pathParts.pop()?.replace(/\.md$/, "") || "";
      const parent = pathParts.length > 0 ? pathParts.join("/") : null;
      const result = await vaultApi.createNote(parent, title);
      const path = result.selectedPath || edit.path;
      const stamped = stampAiProvenance(edit.content || "", baseProvenance, edit.id);
      await vaultApi.saveNote(path, stamped, "");
      await appendAudit("create", path);
      return { ...edit, applied: true, path, provenance: baseProvenance };
    }
    case "update": {
      const doc = await vaultApi.readNote(edit.path);
      const target = edit.targetContent || "";
      const replacement = edit.replacementContent || "";

      if (!doc.content.includes(target)) {
        throw new Error(`Target content not found in ${edit.path}`);
      }

      const occurrences = doc.content.split(target).length - 1;
      if (occurrences > 1) {
        throw new Error(`Ambiguous target: found ${occurrences} occurrences in ${edit.path}`);
      }

      const updatedContent = doc.content.replace(target, () => replacement);
      const stamped = stampAiProvenance(updatedContent, { ...baseProvenance, originalExcerpt: target }, edit.id);
      await vaultApi.saveNote(edit.path, stamped, doc.revision);
      await appendAudit("update", edit.path);
      return { ...edit, applied: true, provenance: { ...baseProvenance, originalExcerpt: target } };
    }
    case "delete":
      await appendAudit("delete", edit.path, { required: true });
      await vaultApi.deleteEntry(edit.path);
      return { ...edit, applied: true, provenance: baseProvenance };
    case "merge": {
      let targetPath = edit.newPath || "";
      let existingRevision = "";
      try {
        const doc = await vaultApi.readNote(targetPath);
        existingRevision = doc.revision;
      } catch (error) {
        if (!isMissingNoteReadError(error)) {
          rethrowReadNoteError(error);
        }
        const pathParts = targetPath.split("/");
        const title = pathParts.pop()?.replace(/\.md$/, "") || "";
        const parent = pathParts.length > 0 ? pathParts.join("/") : null;
        const result = await vaultApi.createNote(parent, title);
        targetPath = result.selectedPath || targetPath;
      }

      const stamped = stampAiProvenance(edit.content || "", baseProvenance, edit.id);
      await vaultApi.saveNote(targetPath, stamped, existingRevision);
      await appendAudit("merge", targetPath);
      if (edit.path !== targetPath) {
        await appendAudit("delete", edit.path, { required: true });
        await vaultApi.deleteEntry(edit.path);
      }
      return { ...edit, applied: true, provenance: baseProvenance };
    }
  }
}
