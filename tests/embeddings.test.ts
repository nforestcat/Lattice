import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getEmbedding, cosineSimilarity } from "../src/api/embeddings";
import type { LlmConfig } from "../src/api/types";

describe("Vector Embeddings & Cosine Similarity", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("cosineSimilarity", () => {
    it("should return 1 for identical vectors", () => {
      const vecA = [1, 2, 3];
      const vecB = [1, 2, 3];
      expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(1.0, 5);
    });

    it("should return 0 for orthogonal vectors", () => {
      const vecA = [1, 0, 0];
      const vecB = [0, 1, 0];
      expect(cosineSimilarity(vecA, vecB)).toBe(0);
    });

    it("should return -1 for opposite vectors", () => {
      const vecA = [1, 2, 3];
      const vecB = [-1, -2, -3];
      expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(-1.0, 5);
    });

    it("should return 0 if vector lengths differ or are empty", () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
      expect(cosineSimilarity([], [])).toBe(0);
    });
  });

  describe("getEmbedding", () => {
    it("should query Ollama with custom model and return the vector", async () => {
      const mockResponse = {
        embedding: [0.1, 0.5, -0.2],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const config: LlmConfig = {
        provider: "ollama",
        apiKey: "",
        model: "llama3",
        embeddingModel: "nomic-embed-text",
        baseUrl: "http://localhost:11434",
      };

      const result = await getEmbedding(config, "hello world");

      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/embeddings",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "nomic-embed-text",
            prompt: "hello world",
          }),
        })
      );
      expect(result).toEqual([0.1, 0.5, -0.2]);
    });

    it("should query OpenAI with default model and return the vector", async () => {
      const mockResponse = {
        data: [
          {
            embedding: [0.99, -0.01],
            index: 0,
          },
        ],
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const config: LlmConfig = {
        provider: "openai",
        apiKey: "sk-openai-key",
        model: "gpt-4",
      };

      const result = await getEmbedding(config, "test plain text");

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/embeddings",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer sk-openai-key",
          },
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: "test plain text",
          }),
        })
      );
      expect(result).toEqual([0.99, -0.01]);
    });
  });
});
