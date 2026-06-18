import { useState, useCallback } from "react";
import type {
  IngestDuplicateCheck,
  IngestQueueItem,
  IngestQueueUpdate,
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
    dup: IngestDuplicateCheck | null
  ) => string;
  updateIngestItem: (id: string, patch: IngestQueueUpdate) => void;
  approveIngestItem: (id: string) => void;
  rejectIngestItem: (id: string) => void;
  applyIngestItem: (id: string) => Promise<readonly string[] | false>;
}

function appendIngestMarkdown(existing: string, title: string, markdown: string): string {
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}### Ingested Source (${title})\n\n${markdown.trim()}\n`;
}

export function useIngestQueue({ onIngested, setVault }: UseIngestQueueOptions): IngestQueueHook {
  const [items, setItems] = useState<IngestQueueItem[]>([]);

  const enqueueIngest = useCallback(
    (
      result: IngestResult,
      raw: IngestRaw,
      dup: IngestDuplicateCheck | null
    ): string => {
      const id = crypto.randomUUID();
      const similarNotes = dup?.similarNotes ?? [];
      const item: IngestQueueItem = {
        id,
        title: result.title,
        tags: result.tags,
        markdown: result.markdown,
        raw,
        targetFolder: "Ingested",
        appendTargetPath: null,
        duplicateExact: dup?.exactMatch ?? null,
        similarNotes,
        suggestedLinks: similarNotes,
        status: "drafted",
        createdAt: Date.now(),
      };
      setItems((prev) => [item, ...prev]);
      return id;
    },
    []
  );

  const updateIngestItem = useCallback(
    (id: string, patch: IngestQueueUpdate) => {
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
      if (!item || item.status === "applied" || item.status === "rejected") return false;

      const markdown = applyTagsToMarkdown(item.markdown, item.tags);
      let createdPath: string | null = null;

      try {
        if (item.appendTargetPath !== null) {
          const appendTargetPath = item.appendTargetPath.trim();
          if (!appendTargetPath) {
            throw new Error("append 대상 노트 경로를 입력해 주세요.");
          }
          const target = await vaultApi.readNote(appendTargetPath);
          await vaultApi.saveNote(
            target.path,
            appendIngestMarkdown(target.content, item.title, markdown),
            target.revision
          );
          setItems((prev) =>
            prev.map((i) =>
              i.id === id ? { ...i, status: "applied" as const } : i
            )
          );
          await onIngested(target.path);
          return [target.path];
        }

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
        return [createdPath];
      } catch (err) {
        if (createdPath) {
          try {
            await vaultApi.deleteEntry(createdPath);
          } catch (rollbackErr) {
            if (rollbackErr instanceof Error) {
              console.warn("Failed to rollback ingest note", rollbackErr.message);
            } else {
              console.warn("Failed to rollback ingest note", String(rollbackErr));
            }
          }
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
