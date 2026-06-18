import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendChatMessage, type ChatMessage } from "../src/api/llm";
import type { LlmConfig } from "../src/api/types";

describe("LLM API Client (sendChatMessage)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should format request and parse response correctly for OpenAI", async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            content: "OpenAI mock response",
          },
        },
      ],
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const config: LlmConfig = {
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4o",
    };

    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
    ];

    const result = await sendChatMessage(config, messages);

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages,
          stream: false,
        }),
      })
    );
    expect(result).toBe("OpenAI mock response");
  });

  it("should reject malformed OpenAI responses", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: {} }] }),
    });

    const config: LlmConfig = {
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-4o",
    };

    await expect(sendChatMessage(config, [{ role: "user", content: "hello" }])).rejects.toThrow(
      "Invalid response from OpenAI-compatible chat API"
    );
  });

  it("should format request and parse response correctly for Ollama", async () => {
    const mockResponse = {
      message: {
        role: "assistant",
        content: "Ollama mock response",
      },
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const config: LlmConfig = {
      provider: "ollama",
      apiKey: "",
      model: "llama3",
      baseUrl: "http://localhost:11434",
    };

    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];

    const result = await sendChatMessage(config, messages);

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/chat",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "llama3",
          messages,
          stream: false,
        }),
      })
    );
    expect(result).toBe("Ollama mock response");
  });

  it("should format request and parse response correctly for Gemini", async () => {
    const mockResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: "Gemini mock response",
              },
            ],
          },
        },
      ],
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const config: LlmConfig = {
      provider: "gemini",
      apiKey: "gemini-key",
      model: "gemini-1.5-pro",
    };

    const messages: ChatMessage[] = [
      { role: "system", content: "system instructions" },
      { role: "user", content: "hello" },
    ];

    const result = await sendChatMessage(config, messages);

    expect(global.fetch).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=gemini-key",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
          systemInstruction: { parts: [{ text: "system instructions" }] },
        }),
      })
    );
    expect(result).toBe("Gemini mock response");
  });

  it("should format request and parse response correctly for Anthropic", async () => {
    const mockResponse = {
      content: [
        {
          type: "text",
          text: "Anthropic mock response",
        },
      ],
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const config: LlmConfig = {
      provider: "anthropic",
      apiKey: "anthropic-key",
      model: "claude-3-5-sonnet",
    };

    const messages: ChatMessage[] = [
      { role: "system", content: "system rules" },
      { role: "user", content: "hello" },
    ];

    const result = await sendChatMessage(config, messages);

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: {
          "x-api-key": "anthropic-key",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "dangerously-allow-browser": "true",
        },
        body: JSON.stringify({
          model: "claude-3-5-sonnet",
          max_tokens: 4000,
          messages: [{ role: "user", content: "hello" }],
          system: "system rules",
        }),
      })
    );
    expect(result).toBe("Anthropic mock response");
  });
});
