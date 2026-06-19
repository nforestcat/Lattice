import { useState, useCallback } from "react";
import { vaultApi } from "../../api";
import { type VectorCache, type EmbeddingsStatus } from "../../api/embeddings";
import { embedNote } from "./useEmbeddings";
import type { LlmConfig, VaultSnapshot } from "../../api/types";

function parseJsonSafe<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw); } catch { return fallback; }
}

export type FailedNote = {
  path: string;
  lastError: string;
  failedAt?: string;
};

export function useEmbeddingsIndex(
  llmConfig: LlmConfig | null,
  vault: VaultSnapshot | null
) {
  const [indexedCount, setIndexedCount] = useState(0);
  const [staleCount, setStaleCount] = useState(0);
  const [failedNotes, setFailedNotes] = useState<FailedNote[]>([]);
  const [isReindexing, setIsReindexing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    if (!vault) return;
    const cache = parseJsonSafe<VectorCache>(await vaultApi.loadEmbeddingsCache(), {});
    const status = parseJsonSafe<EmbeddingsStatus>(await vaultApi.loadEmbeddingsStatus(), {});

    let indexed = 0;
    let stale = 0;
    const failed: FailedNote[] = [];

    for (const note of vault.notes) {
      const entry = cache[note.path];
      const isStale = !entry || entry.contentHash !== note.contentHash;
      if (!isStale) {
        indexed++;
      } else {
        stale++;
      }
      const statusEntry = status[note.path];
      if (statusEntry?.lastError && isStale) {
        failed.push({ path: note.path, lastError: statusEntry.lastError, failedAt: statusEntry.failedAt });
      }
    }

    setIndexedCount(indexed);
    setStaleCount(stale);
    setFailedNotes(failed);
    setLastRefreshed(new Date());
  }, [vault]);

  const reindex = useCallback(async () => {
    if (!llmConfig || !vault) return;
    setIsReindexing(true);
    try {
      const cache = parseJsonSafe<VectorCache>(await vaultApi.loadEmbeddingsCache(), {});
      const status = parseJsonSafe<EmbeddingsStatus>(await vaultApi.loadEmbeddingsStatus(), {});

      const toProcess = vault.notes.filter((note) => {
        const entry = cache[note.path];
        const isStale = !entry || entry.contentHash !== note.contentHash;
        if (isStale) return true;
        const statusEntry = status[note.path];
        return Boolean(statusEntry?.lastError);
      });

      for (const note of toProcess) {
        try {
          const doc = await vaultApi.readNote(note.path);
          const result = await embedNote(llmConfig, doc.content);
          if ("error" in result) {
            status[note.path] = {
              ...status[note.path],
              lastError: result.error,
              failedAt: new Date().toISOString(),
            };
          } else {
            cache[note.path] = { contentHash: note.contentHash, vector: result.vector };
            status[note.path] = { lastIndexedAt: new Date().toISOString() };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          status[note.path] = {
            ...status[note.path],
            lastError: msg,
            failedAt: new Date().toISOString(),
          };
        }
      }

      // Re-read the cache before saving to merge with concurrent writes from useEmbeddings
      const latestCache = parseJsonSafe<VectorCache>(await vaultApi.loadEmbeddingsCache(), {});
      for (const [path, entry] of Object.entries(cache)) {
        latestCache[path] = entry;
      }
      await vaultApi.saveEmbeddingsCache(JSON.stringify(latestCache));
      await vaultApi.saveEmbeddingsStatus(JSON.stringify(status));
      await refresh();
    } finally {
      setIsReindexing(false);
    }
  }, [llmConfig, vault, refresh]);

  return {
    indexedCount,
    staleCount,
    failedNotes,
    isReindexing,
    lastRefreshed,
    refresh,
    reindex,
  };
}
