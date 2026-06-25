import { useCallback, useState } from "react";
import { vaultApi } from "../../api";
import type {
  EntryMutationResult,
  IngestDuplicateCheck,
  IngestQueueItem,
  IngestQueueUpdate,
  IngestRaw,
  IngestResult,
  SaveResult,
  SourceMutationResult,
  SourceMutationWarning,
} from "../../api/types";
import { applyTagsToMarkdown } from "../../core/ingestMarkdown";

export interface UseIngestQueueOptions {
  onIngested: (path: string) => void | Promise<void>;
  setVault: (vault: EntryMutationResult["vault"]) => void;
}

export interface IngestQueueHook {
  ingestItems: IngestQueueItem[];
  enqueueIngest: (
    result: IngestResult,
    raw: IngestRaw,
    dup: IngestDuplicateCheck | null,
  ) => string;
  updateIngestItem: (id: string, patch: IngestQueueUpdate) => void;
  applyIngestItem: (id: string) => Promise<SourceMutationResult>;
}

class IngestApplyError extends Error {
  readonly code: "item_not_found" | "invalid_append_target" | "missing_created_path" | "save_not_durable";
  readonly path: string | undefined;
  readonly saveResult: SaveResult | undefined;

  constructor(
    code: IngestApplyError["code"],
    message: string,
    details?: { readonly path: string; readonly saveResult: SaveResult },
  ) {
    super(message);
    this.name = "IngestApplyError";
    this.code = code;
    this.path = details?.path;
    this.saveResult = details?.saveResult;
  }
}

function appendIngestMarkdown(existing: string, title: string, markdown: string): string {
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}### Ingested Source (${title})\n\n${markdown.trim()}\n`;
}

function warningFor(error: unknown, path: string): SourceMutationWarning {
  return {
    code: "post_action_failed",
    message: error instanceof Error ? error.message : String(error),
    path,
  };
}

function durableSaveResult(path: string, result: SaveResult): void {
  if (result.saved) return;
  throw new IngestApplyError(
    "save_not_durable",
    `Save did not complete for ${path}: conflict=${result.conflict}, snapshot=${result.snapshotId ?? "none"}`,
    { path, saveResult: result },
  );
}

export function useIngestQueue({
  onIngested,
  setVault,
}: UseIngestQueueOptions): IngestQueueHook {
  const [items, setItems] = useState<IngestQueueItem[]>([]);

  const enqueueIngest = useCallback(
    (
      result: IngestResult,
      raw: IngestRaw,
      dup: IngestDuplicateCheck | null,
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
        createdAt: Date.now(),
      };
      setItems((previous) => [item, ...previous]);
      return id;
    },
    [],
  );

  const updateIngestItem = useCallback((id: string, patch: IngestQueueUpdate) => {
    setItems((previous) =>
      previous.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }, []);

  const notifyIngested = useCallback(
    async (path: string): Promise<readonly SourceMutationWarning[]> => {
      try {
        await onIngested(path);
        return [];
      } catch (error) {
        return [
          warningFor(error instanceof Error ? error : new Error(String(error)), path),
        ];
      }
    },
    [onIngested],
  );

  const applyIngestItem = useCallback(
    async (id: string): Promise<SourceMutationResult> => {
      const item = items.find((candidate) => candidate.id === id);
      if (!item) {
        throw new IngestApplyError("item_not_found", `Ingest queue item not found: ${id}`);
      }

      const markdown = applyTagsToMarkdown(item.markdown, item.tags);
      if (item.appendTargetPath !== null) {
        const appendTargetPath = item.appendTargetPath.trim();
        if (!appendTargetPath) {
          throw new IngestApplyError(
            "invalid_append_target",
            "append 대상 노트 경로를 입력해 주세요.",
          );
        }
        const target = await vaultApi.readNote(appendTargetPath);
        durableSaveResult(appendTargetPath, await vaultApi.saveNote(
          target.path,
          appendIngestMarkdown(target.content, item.title, markdown),
          target.revision,
        ));
        return {
          changedPaths: [target.path],
          warnings: await notifyIngested(target.path),
        };
      }

      const createResult = await vaultApi.createNote(item.targetFolder, item.title);
      const createdPath = createResult.selectedPath;
      if (!createdPath) {
        throw new IngestApplyError(
          "missing_created_path",
          "생성된 노트 경로를 찾지 못했습니다.",
        );
      }

      try {
        durableSaveResult(createdPath, await vaultApi.saveNote(createdPath, markdown, ""));
      } catch (error) {
        try {
          await vaultApi.deleteEntry(createdPath);
        } catch (rollbackError) {
          if (rollbackError instanceof Error) {
            console.warn("Failed to rollback ingest note", rollbackError.message);
          } else {
            console.warn("Failed to rollback ingest note", String(rollbackError));
          }
        }
        throw error;
      }

      const warnings: SourceMutationWarning[] = [];
      try {
        setVault(createResult.vault);
      } catch (error) {
        warnings.push(
          warningFor(error instanceof Error ? error : new Error(String(error)), createdPath),
        );
      }
      warnings.push(...await notifyIngested(createdPath));
      return { changedPaths: [createdPath], warnings };
    },
    [items, notifyIngested, setVault],
  );

  return {
    ingestItems: items,
    enqueueIngest,
    updateIngestItem,
    applyIngestItem,
  };
}
