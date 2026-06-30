import { useEffect, type Dispatch, type SetStateAction } from "react";
import { vaultApi } from "../../api";
import { canUseEmbeddings, getEmbedding, type VectorCache } from "../../api/embeddings";
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
          setEmbeddingsCache((prev) => {
            const nextCache = {
              ...prev,
              [activePath]: {
                contentHash: hash,
                vector,
              },
            };
            void vaultApi.saveEmbeddingsCache(JSON.stringify(nextCache));
            return nextCache;
          });

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
