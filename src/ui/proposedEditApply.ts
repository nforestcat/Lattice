import { vaultApi } from "../api";
import type { AiAuditRecord, ProposedEdit } from "../api/types";
import { stampAiProvenance } from "../core/provenance";

export async function applyProposedEditToVault(edit: ProposedEdit): Promise<ProposedEdit> {
  const appliedAt = new Date().toISOString();
  const baseProvenance = edit.provenance
    ? { ...edit.provenance, appliedAt }
    : { source: "unknown", appliedAt };

  async function appendAudit(type: ProposedEdit["type"], path: string): Promise<void> {
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
      if (type === "delete") {
        console.warn("[provenance] Failed to write audit log for delete — provenance may be unrecoverable:", err);
      } else {
        console.error("[provenance] Failed to write audit log (non-fatal):", err);
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

      const updatedContent = doc.content.replace(target, replacement);
      const stamped = stampAiProvenance(updatedContent, { ...baseProvenance, originalExcerpt: target }, edit.id);
      await vaultApi.saveNote(edit.path, stamped, doc.revision);
      await appendAudit("update", edit.path);
      return { ...edit, applied: true, provenance: { ...baseProvenance, originalExcerpt: target } };
    }
    case "delete":
      await vaultApi.deleteEntry(edit.path);
      await appendAudit("delete", edit.path);
      return { ...edit, applied: true, provenance: baseProvenance };
    case "merge": {
      let targetPath = edit.newPath || "";
      let existingRevision = "";
      try {
        const doc = await vaultApi.readNote(targetPath);
        existingRevision = doc.revision;
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
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
      // source note deletion — audit separately as delete
      await appendAudit("delete", edit.path);
      await vaultApi.deleteEntry(edit.path);
      return { ...edit, applied: true, provenance: baseProvenance };
    }
  }
}
