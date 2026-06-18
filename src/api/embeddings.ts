import type { LlmConfig } from "./types";
import { invoke } from "@tauri-apps/api/core";
import { isDesktopRuntime } from "./runtime";

export type VectorCacheEntry = {
  contentHash: string;
  vector: number[];
};

export type VectorCache = Record<string, VectorCacheEntry>;

export type EmbeddingsStatusEntry = {
  lastError?: string;
  failedAt?: string;
  lastIndexedAt?: string;
};

export type EmbeddingsStatus = Record<string, EmbeddingsStatusEntry>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseNumberVector(value: unknown): number[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "number") ? value : null;
}

function parseOllamaEmbedding(data: unknown): number[] | null {
  return parseNumberVector(isRecord(data) ? data.embedding : undefined);
}

function parseOpenAiEmbedding(data: unknown): number[] | null {
  const first = isRecord(data) && Array.isArray(data.data) ? data.data[0] : undefined;
  return parseNumberVector(isRecord(first) ? first.embedding : undefined);
}

function configForRemoteEmbedding(config: LlmConfig): LlmConfig {
  const provider = config.embeddingProvider;
  if (!provider || provider === "local-onnx" || provider === config.provider) {
    return config;
  }

  return {
    ...config,
    provider,
    baseUrl: provider === "custom" ? config.baseUrl : undefined,
  };
}

export function canUseEmbeddings(config: LlmConfig | null): boolean {
  if (!config) return false;
  if (config.embeddingProvider === "local-onnx") return true;
  const provider = config.embeddingProvider ?? config.provider;
  return provider === "ollama" || provider === "lm-studio" || config.apiKey.trim().length > 0;
}

export async function getEmbedding(config: LlmConfig, text: string): Promise<number[]> {
  const sanitizedText = text.trim();
  if (!sanitizedText) {
    return [];
  }

  // local-onnx: Tauri 커맨드 직접 호출
  if (config.embeddingProvider === "local-onnx") {
    return invoke<number[]>("get_local_embedding", { text: sanitizedText });
  }

  const embeddingConfig = configForRemoteEmbedding(config);

  if (isDesktopRuntime()) {
    const redactedConfig = { ...embeddingConfig, apiKey: "" };
    return invoke<number[]>("get_llm_embedding", { config: redactedConfig, text: sanitizedText });
  }

  const { provider, apiKey, embeddingModel, baseUrl } = embeddingConfig;
  const model = embeddingModel || (provider === "openai" ? "text-embedding-3-small" : "all-minilm");

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

      const data: unknown = await response.json();
      const embedding = parseOllamaEmbedding(data);
      if (embedding === null) {
        throw new Error("Invalid response from Ollama embedding API");
      }
      return embedding;
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

      const data: unknown = await response.json();
      const embedding = parseOpenAiEmbedding(data);
      if (embedding === null) {
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
