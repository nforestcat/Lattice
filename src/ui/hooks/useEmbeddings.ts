import { useState, useRef } from "react";
import { vaultApi } from "../../api";
import {
  canUseEmbeddings,
  getEmbedding,
  cosineSimilarity,
  embeddingModelId,
  parseEmbeddingsCache,
  serializeEmbeddingsCache,
  type VectorCache,
} from "../../api/embeddings";
import type { LlmConfig, VaultSnapshot, ContextBundleCandidate } from "../../api/types";
import type { NoteMeta } from "../../core/types";
import { estimateTokens } from "../../core/contextBundle";

export async function embedNote(
  config: LlmConfig,
  content: string
): Promise<{ vector: number[] } | { error: string }> {
  try {
    const vector = await getEmbedding(config, content);
    if (vector.length === 0) return { error: "Empty vector returned" };
    return { vector };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function useEmbeddings(llmConfig: LlmConfig | null, vault: VaultSnapshot | null) {
  const [embeddingsCache, setEmbeddingsCache] = useState<VectorCache>({});
  const [embeddingStatus, setEmbeddingStatus] = useState("");
  const [isSearchingSemantic, setIsSearchingSemantic] = useState(false);
  const [semanticSearchError, setSemanticSearchError] = useState<string | null>(null);
  const activePathRef = useRef<string | null>(null);

  async function updateSemanticRecommendations(
    path: string,
    config: LlmConfig,
    notes: NoteMeta[],
    setContextCandidates: React.Dispatch<React.SetStateAction<ContextBundleCandidate[]>>
  ) {
    if (!config || !canUseEmbeddings(config)) {
      return;
    }

    const capturedPath = path;
    activePathRef.current = capturedPath;

    setEmbeddingStatus("Semantic indexing...");
    try {
      const modelId = embeddingModelId(config);
      const cache: VectorCache = parseEmbeddingsCache(await vaultApi.loadEmbeddingsCache(), modelId);

      let cacheUpdated = false;
      const notesToProcess = notes;
      const noteContents: Record<string, string> = {};

      for (const note of notesToProcess) {
        const cached = cache[note.path];
        if (!cached || cached.contentHash !== note.contentHash) {
          const doc = await vaultApi.readNote(note.path);
          noteContents[note.path] = doc.content;
          const result = await embedNote(config, doc.content);
          if ("error" in result) {
            console.error(`Failed to generate embedding for ${note.path}:`, result.error);
            if (cacheUpdated) {
              await vaultApi.saveEmbeddingsCache(serializeEmbeddingsCache(modelId, cache));
            }
            setEmbeddingStatus("Embedding error (API unreachable)");
            return;
          }
          cache[note.path] = { contentHash: note.contentHash, vector: result.vector };
          cacheUpdated = true;
        }
      }

      if (cacheUpdated) {
        await vaultApi.saveEmbeddingsCache(serializeEmbeddingsCache(modelId, cache));
      }

      if (activePathRef.current !== capturedPath) return;

      setEmbeddingsCache(cache);

      const activeEntry = cache[path];
      if (!activeEntry) {
        setEmbeddingStatus("Semantic indexing failed (Active note missing vector)");
        return;
      }

      const activeVector = activeEntry.vector;

      // Collect recommendations first
      const recommendedItems: { note: NoteMeta; similarity: number; score: number; reasonDetail: string }[] = [];
      for (const note of notesToProcess) {
        if (note.path === path) continue;
        const entry = cache[note.path];
        if (!entry) continue;

        const similarity = cosineSimilarity(activeVector, entry.vector);
        if (similarity >= 0.5) {
          const score = Math.min(9.5, Number((similarity * 10).toFixed(1)));
          const reasonDetail = `Semantic similarity: ${Math.round(similarity * 100)}%`;
          recommendedItems.push({ note, similarity, score, reasonDetail });
        }
      }

      // Read contents of recommended items sequentially or retrieve from noteContents
      const enrichedRecommended: { path: string; title: string; reasonDetail: string; score: number; excerpt: string; tokenEstimate: number; characterCount: number }[] = [];
      for (const item of recommendedItems) {
        let content = noteContents[item.note.path];
        if (content === undefined) {
          try {
            const doc = await vaultApi.readNote(item.note.path);
            content = doc.content;
            noteContents[item.note.path] = content;
          } catch (err) {
            console.error(`Failed to read content for recommendation: ${item.note.path}`, err);
            continue;
          }
        }
        enrichedRecommended.push({
          path: item.note.path,
          title: item.note.title,
          reasonDetail: item.reasonDetail,
          score: item.score,
          excerpt: content.slice(0, 100).replace(/\s+/g, " ").trim() + "...",
          tokenEstimate: estimateTokens(content),
          characterCount: content.length,
        });
      }

      if (activePathRef.current !== capturedPath) return;

      setContextCandidates((prev) => {
        const next = [...prev];

        for (const item of enrichedRecommended) {
          const existingIdx = next.findIndex((c) => c.path === item.path);
          if (existingIdx !== -1) {
            const prevItem = next[existingIdx];
            next[existingIdx] = {
              ...prevItem,
              score: Math.max(prevItem.score, item.score),
              reasonDetail: prevItem.reason === "Recommended"
                ? item.reasonDetail
                : prevItem.reasonDetail.includes("Semantic")
                  ? prevItem.reasonDetail.replace(/Semantic[^|]*%/, item.reasonDetail.replace(/^.*?(Semantic.*)/, "$1"))
                  : `${prevItem.reasonDetail} | ${item.reasonDetail}`
            };
          } else {
            next.push({
              path: item.path,
              title: item.title,
              reason: "Recommended",
              reasonDetail: item.reasonDetail,
              score: item.score,
              excerpt: item.excerpt,
              tokenEstimate: item.tokenEstimate,
              selected: false,
              characterCount: item.characterCount
            });
          }
        }

        return next.sort((a, b) => b.score - a.score);
      });

      setEmbeddingStatus("Semantic index updated");
    } catch (err) {
      console.error("Semantic recommendation error:", err);
      setEmbeddingStatus("Semantic index failed");
    }
  }

  async function runSemanticSearch(
    searchQuery: string,
    setResults: React.Dispatch<React.SetStateAction<(NoteMeta & { similarity?: number })[]>>
  ) {
    const q = searchQuery.trim();
    if (!q) {
      setResults([]);
      setSemanticSearchError(null);
      return;
    }

    const config = llmConfig;
    if (!config || !canUseEmbeddings(config)) {
      setSemanticSearchError("Semantic search needs an embedding provider. Choose 'Local (ONNX)' in the Distill Settings to download the offline model (~113 MB, no API key needed), or configure an API key / Ollama / LM Studio.");
      return;
    }

    setIsSearchingSemantic(true);
    setSemanticSearchError(null);
    try {
      const modelId = embeddingModelId(config);
      const cache: VectorCache = parseEmbeddingsCache(await vaultApi.loadEmbeddingsCache(), modelId);

      const notesToProcess = vault?.notes || [];
      let cacheUpdated = false;

      for (const note of notesToProcess) {
        const cached = cache[note.path];
        if (!cached || cached.contentHash !== note.contentHash) {
          try {
            const doc = await vaultApi.readNote(note.path);
            const result = await embedNote(config, doc.content);
            if ("error" in result) {
              console.error(`Semantic search: failed to embed note ${note.path}:`, result.error);
              continue;
            }
            // ponytail: cache-write stays per-caller (recommendation persists partial-then-halts,
            // search persists once at the end) — mechanism is shared via embedNote, policy is not.
            cache[note.path] = { contentHash: note.contentHash, vector: result.vector };
            cacheUpdated = true;
          } catch (err) {
            console.error(`Semantic search: failed to read or embed note ${note.path}:`, err);
          }
        }
      }

      if (cacheUpdated) {
        await vaultApi.saveEmbeddingsCache(serializeEmbeddingsCache(modelId, cache));
      }
      setEmbeddingsCache(cache);

      const queryVector = await getEmbedding(config, q);
      if (queryVector.length === 0) {
        throw new Error("Could not compute embedding for query");
      }

      const searchResults: (NoteMeta & { similarity: number })[] = [];
      for (const note of notesToProcess) {
        const entry = cache[note.path];
        if (!entry) continue;

        const similarity = cosineSimilarity(queryVector, entry.vector);
        if (similarity >= 0.3) {
          searchResults.push({
            ...note,
            similarity
          });
        }
      }

      searchResults.sort((a, b) => b.similarity - a.similarity);
      setResults(searchResults);
    } catch (err) {
      console.error("Semantic search error:", err);
      const errMsg = err instanceof Error ? err.message : String(err);
      setSemanticSearchError(`Search failed: ${errMsg}`);
    } finally {
      setIsSearchingSemantic(false);
    }
  }

  return {
    embeddingsCache,
    setEmbeddingsCache,
    embeddingStatus,
    setEmbeddingStatus,
    isSearchingSemantic,
    setIsSearchingSemantic,
    semanticSearchError,
    setSemanticSearchError,
    updateSemanticRecommendations,
    runSemanticSearch,
  };
}
