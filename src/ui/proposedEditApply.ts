import { vaultApi } from "../api";
import type { ProposedEdit } from "../api/types";

export async function applyProposedEditToVault(edit: ProposedEdit): Promise<ProposedEdit> {
  switch (edit.type) {
    case "create": {
      const pathParts = edit.path.split("/");
      const title = pathParts.pop()?.replace(/\.md$/, "") || "";
      const parent = pathParts.length > 0 ? pathParts.join("/") : null;
      const result = await vaultApi.createNote(parent, title);
      const path = result.selectedPath || edit.path;
      await vaultApi.saveNote(path, edit.content || "", "");
      return { ...edit, applied: true, path };
    }
    case "update": {
      const doc = await vaultApi.readNote(edit.path);
      const target = edit.targetContent || "";
      const replacement = edit.replacementContent || "";

      if (!doc.content.includes(target)) {
        throw new Error(`Target content not found in ${edit.path}`);
      }

      await vaultApi.saveNote(edit.path, doc.content.replace(target, replacement), doc.revision);
      return { ...edit, applied: true };
    }
    case "delete":
      await vaultApi.deleteEntry(edit.path);
      return { ...edit, applied: true };
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

      await vaultApi.saveNote(targetPath, edit.content || "", existingRevision);
      await vaultApi.deleteEntry(edit.path);
      return { ...edit, applied: true };
    }
  }
}
