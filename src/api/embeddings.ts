import type { LlmConfig } from "./types";

export type VectorCacheEntry = {
  contentHash: string;
  vector: number[];
};

export type VectorCache = Record<string, VectorCacheEntry>;

import { invoke } from "@tauri-apps/api/core";

export async function getEmbedding(config: LlmConfig, text: string): Promise<number[]> {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    const redactedConfig = { ...config, apiKey: "" };
    return invoke<number[]>("get_llm_embedding", { config: redactedConfig, text });
  }

  const { provider, apiKey, embeddingModel, baseUrl } = config;
  const model = embeddingModel || (provider === "openai" ? "text-embedding-3-small" : "all-minilm");

  const sanitizedText = text.trim();
  if (!sanitizedText) {
    return [];
  }

  switch (provider) {
    case "ollama": {
      const url = `${baseUrl || "http://localhost:11434"}/api/embeddings`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: sanitizedText,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama embedding error: ${response.statusText}`);
      }

      const data = await response.json();
      if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error("Invalid response from Ollama embedding API");
      }
      return data.embedding;
    }

    case "lm-studio":
    case "openai":
    case "custom": {
      const defaultBase = provider === "openai" ? "https://api.openai.com/v1" : (provider === "lm-studio" ? "http://localhost:1234/v1" : "");
      const base = baseUrl || defaultBase;
      if (!base) {
        throw new Error("Base URL is required for custom/LM Studio provider");
      }
      const url = `${base.replace(/\/$/, "")}/embeddings`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          input: sanitizedText,
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`OpenAI embedding error: ${response.statusText} ${errText}`);
      }

      const data = await response.json();
      const embedding = data.data?.[0]?.embedding;
      if (!embedding || !Array.isArray(embedding)) {
        throw new Error("Invalid response from OpenAI embedding API");
      }
      return embedding;
    }

    default:
      throw new Error(`Embedding is not supported or not implemented for provider: ${provider}`);
  }
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) {
    return 0;
  }

  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
