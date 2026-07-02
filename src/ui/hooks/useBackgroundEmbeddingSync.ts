import { useEffect, type Dispatch, type SetStateAction } from "react";
import { vaultApi } from "../../api";
import {
  canUseEmbeddings,
  getEmbedding,
  embeddingModelId,
  parseEmbeddingsCache,
  serializeEmbeddingsCache,
  type VectorCache,
} from "../../api/embeddings";
import type { LlmConfig, NoteDocument } from "../../api/types";
import type { NoteMeta } from "../../core/types";
import { computeHash } from "../llmSecrets";

type BackgroundEmbeddingSyncOptions = {
  readonly activePath: string | null;
  readonly draft: string;
  readonly document: NoteDocument | null;
  readonly llmConfig: LlmConfig | null;
  readonly notes: readonly NoteMeta[] | undefined;
  readonly setEmbeddingsCache: Dispatch<SetStateAction<VectorCache>>;
  readonly updateSemanticRecommendations: (
    path: string,
    config: LlmConfig,
    notes: readonly NoteMeta[],
  ) => void;
};

export function useBackgroundEmbeddingSync({
  activePath,
  draft,
  document,
  llmConfig,
  notes,
  setEmbeddingsCache,
  updateSemanticRecommendations,
}: BackgroundEmbeddingSyncOptions) {
  useEffect(() => {
    const config = llmConfig;
    if (!config || !canUseEmbeddings(config)) {
      return;
    }
    if (!activePath || !draft) {
      return;
    }
    if (!document || document.path !== activePath || draft === document.content) {
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const hash = await computeHash(draft);

        let alreadyExists = false;
        setEmbeddingsCache((prev) => {
          const cached = prev[activePath];
          if (cached && cached.contentHash === hash) {
            alreadyExists = true;
          }
          return prev;
        });

        if (alreadyExists) {
          return;
        }

        const vector = await getEmbedding(config, draft);
        if (vector.length > 0) {
          const entry = { contentHash: hash, vector };
          // Merge into the on-disk cache instead of overwriting it with React
          // state, so vectors from a previously configured model never leak
          // into the current model's cache file.
          const modelId = embeddingModelId(config);
          const diskCache = parseEmbeddingsCache(await vaultApi.loadEmbeddingsCache(), modelId);
          diskCache[activePath] = entry;
          void vaultApi.saveEmbeddingsCache(serializeEmbeddingsCache(modelId, diskCache));

          setEmbeddingsCache((prev) => ({ ...prev, [activePath]: entry }));
          updateSemanticRecommendations(activePath, config, notes ?? []);
        }
      } catch (err) {
        console.error("Background embedding sync error:", err);
      }
    }, 3000);

    return () => clearTimeout(timer);
  }, [
    activePath,
    document,
    draft,
    llmConfig,
    notes,
    setEmbeddingsCache,
    updateSemanticRecommendations,
  ]);
}
