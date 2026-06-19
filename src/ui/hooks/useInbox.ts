import { useState } from "react";
import { vaultApi } from "../../api";
import type { VaultSnapshot } from "../../api/types";
import type { NoteMeta } from "../../core/types";
import type { InboxCaptureBlock } from "../../core/capture";
import { errorMessage } from "./contextShared";

export interface UseInboxCallbacks {
  vault: VaultSnapshot | null;
  setVault: React.Dispatch<React.SetStateAction<VaultSnapshot | null>>;
  activePath: string | null;
  setResults: (notes: NoteMeta[]) => void;
  setStatus: (status: string) => void;
  selectNote: (path: string) => Promise<void>;
}

export function useInbox(callbacks: UseInboxCallbacks) {
  const { vault, setVault, activePath, setResults, setStatus, selectNote } = callbacks;

  const [inboxCaptures, setInboxCaptures] = useState<InboxCaptureBlock[]>([]);
  const [captureDraft, setCaptureDraft] = useState("");
  const [triageCaptureToAppend, setTriageCaptureToAppend] = useState<{ id: string; title: string } | null>(null);
  const [noteSearchQuery, setNoteSearchQuery] = useState("");

  async function captureToInbox() {
    if (!vault || !captureDraft.trim()) {
      return;
    }
    try {
      const result = await vaultApi.captureToInbox({
        content: captureDraft,
        relatedPath: activePath,
        capturedAt: new Date().toISOString()
      });
      setCaptureDraft("");
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Captured to ${result.selectedPath}`);
      if (result.selectedPath) {
        await selectNote(result.selectedPath);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function promoteInboxCapture(captureId: string) {
    if (!activePath) {
      return;
    }
    const title = window.prompt("New note title");
    if (!title) {
      return;
    }
    try {
      const result = await vaultApi.promoteInboxCapture({
        inboxPath: activePath,
        captureId,
        title
      });
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Promoted to ${result.selectedPath}`);
      if (result.selectedPath) {
        await selectNote(result.selectedPath);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function markInboxCaptureProcessed(captureId: string): Promise<readonly string[] | false> {
    if (!activePath) {
      return false;
    }
    const capturedPath = activePath;
    try {
      const result = await vaultApi.markInboxCaptureProcessed(capturedPath, captureId);
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus("Capture marked processed");
      if (activePath === capturedPath) {
        await selectNote(capturedPath);
      }
      return [capturedPath];
    } catch (error) {
      setStatus(errorMessage(error));
      return false;
    }
  }

  async function handleAppendCapture(targetPath: string) {
    if (!activePath || !triageCaptureToAppend) {
      return;
    }
    try {
      const result = await vaultApi.appendInboxCapture({
        inboxPath: activePath,
        captureId: triageCaptureToAppend.id,
        targetPath
      });
      setTriageCaptureToAppend(null);
      setNoteSearchQuery("");
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Appended capture to ${result.selectedPath}`);
      if (result.selectedPath) {
        await selectNote(result.selectedPath);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  return {
    inboxCaptures, setInboxCaptures,
    captureDraft, setCaptureDraft,
    triageCaptureToAppend, setTriageCaptureToAppend,
    noteSearchQuery, setNoteSearchQuery,
    captureToInbox,
    promoteInboxCapture,
    markInboxCaptureProcessed,
    handleAppendCapture,
  };
}
