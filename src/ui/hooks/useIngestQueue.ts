import { useState, useCallback } from "react";
import type {
  IngestQueueItem,
  IngestRaw,
  IngestResult,
  EntryMutationResult,
} from "../../api/types";
import { applyTagsToMarkdown } from "../../core/ingestMarkdown";
import { vaultApi } from "../../api";

export interface UseIngestQueueOptions {
  onIngested: (path: string) => void | Promise<void>;
  setVault: (vault: EntryMutationResult["vault"]) => void;
}

export interface IngestQueueHook {
  ingestItems: IngestQueueItem[];
  enqueueIngest: (
    result: IngestResult,
    raw: IngestRaw,
    dup: { exactMatch: string | null; similarNotes: { path: string; title: string }[] } | null
  ) => string;
  updateIngestItem: (id: string, patch: Partial<Pick<IngestQueueItem, "title" | "tags" | "markdown" | "targetFolder">>) => void;
  approveIngestItem: (id: string) => void;
  rejectIngestItem: (id: string) => void;
  applyIngestItem: (id: string) => Promise<void>;
}

export function useIngestQueue({ onIngested, setVault }: UseIngestQueueOptions): IngestQueueHook {
  const [items, setItems] = useState<IngestQueueItem[]>([]);

  const enqueueIngest = useCallback(
    (
      result: IngestResult,
      raw: IngestRaw,
      dup: { exactMatch: string | null; similarNotes: { path: string; title: string }[] } | null
    ): string => {
      const id = crypto.randomUUID();
      const item: IngestQueueItem = {
        id,
        title: result.title,
        tags: result.tags,
        markdown: result.markdown,
        raw,
        targetFolder: "Ingested",
        duplicateExact: dup?.exactMatch ?? null,
        similarNotes: dup?.similarNotes ?? [],
        status: "drafted",
        createdAt: Date.now(),
      };
      setItems((prev) => [item, ...prev]);
      return id;
    },
    []
  );

  const updateIngestItem = useCallback(
    (id: string, patch: Partial<Pick<IngestQueueItem, "title" | "tags" | "markdown" | "targetFolder">>) => {
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
      );
    },
    []
  );

  const approveIngestItem = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id && item.status === "drafted"
          ? { ...item, status: "approved" as const }
          : item
      )
    );
  }, []);

  const rejectIngestItem = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id && (item.status === "drafted" || item.status === "approved")
          ? { ...item, status: "rejected" as const }
          : item
      )
    );
  }, []);

  const applyIngestItem = useCallback(
    async (id: string) => {
      const item = items.find((i) => i.id === id);
      if (!item || item.status === "applied" || item.status === "rejected") return;

      const markdown = applyTagsToMarkdown(item.markdown, item.tags);
      let createdPath: string | null = null;

      try {
        const createResult = await vaultApi.createNote(item.targetFolder, item.title);
        if (!createResult.selectedPath) {
          throw new Error("생성된 노트 경로를 찾지 못했습니다.");
        }
        createdPath = createResult.selectedPath;
        await vaultApi.saveNote(createdPath, markdown, "");
        setVault(createResult.vault);
        setItems((prev) =>
          prev.map((i) =>
            i.id === id ? { ...i, status: "applied" as const } : i
          )
        );
        await onIngested(createdPath);
      } catch (err) {
        if (createdPath) {
          try { await vaultApi.deleteEntry(createdPath); } catch { /* best effort rollback */ }
        }
        throw err;
      }
    },
    [items, onIngested, setVault]
  );

  return {
    ingestItems: items,
    enqueueIngest,
    updateIngestItem,
    approveIngestItem,
    rejectIngestItem,
    applyIngestItem,
  };
}
