import type { LlmConfig } from "./types";
import { invoke } from "@tauri-apps/api/core";
import { isDesktopRuntime } from "./runtime";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

type GeminiContent = {
  readonly role: "model" | "user";
  readonly parts: readonly { readonly text: string }[];
};

type GeminiRequest = {
  readonly contents: readonly GeminiContent[];
  readonly systemInstruction?: { readonly parts: readonly { readonly text: string }[] };
};

type AnthropicMessage = {
  readonly role: "assistant" | "user";
  readonly content: string;
};

type AnthropicRequest = {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly AnthropicMessage[];
  readonly system?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstItem(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

function stringProperty(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const property = value[key];
  return typeof property === "string" ? property : null;
}

function parseOpenAiChatContent(data: unknown): string | null {
  const choice = firstItem(isRecord(data) ? data.choices : undefined);
  const message = isRecord(choice) ? choice.message : undefined;
  return stringProperty(message, "content");
}

function parseOllamaChatContent(data: unknown): string | null {
  const message = isRecord(data) ? data.message : undefined;
  return stringProperty(message, "content");
}

function parseGeminiChatContent(data: unknown): string | null {
  const candidate = firstItem(isRecord(data) ? data.candidates : undefined);
  const content = isRecord(candidate) ? candidate.content : undefined;
  const part = firstItem(isRecord(content) ? content.parts : undefined);
  return stringProperty(part, "text");
}

function parseAnthropicChatContent(data: unknown): string | null {
  const content = firstItem(isRecord(data) ? data.content : undefined);
  return stringProperty(content, "text");
}

export async function sendChatMessage(
  config: LlmConfig,
  messages: ChatMessage[]
): Promise<string> {
  if (isDesktopRuntime()) {
    const redactedConfig = { ...config, apiKey: "" };
    return invoke<string>("send_llm_chat_message", { config: redactedConfig, messages });
  }

  const { provider, apiKey, model, baseUrl } = config;

  switch (provider) {
    case "ollama": {
      const url = `${baseUrl || "http://localhost:11434"}/api/chat`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.statusText}`);
      }

      const data: unknown = await response.json();
      const content = parseOllamaChatContent(data);
      if (content === null) {
        throw new Error("Invalid response from Ollama chat API");
      }
      return content;
    }

    case "lm-studio":
    case "openai":
    case "custom": {
      const defaultBase = provider === "openai" ? "https://api.openai.com/v1" : (provider === "lm-studio" ? "http://localhost:1234/v1" : "");
      const base = baseUrl || defaultBase;
      if (!base) {
        throw new Error("Base URL is required for custom/LM Studio provider");
      }
      const url = `${base.replace(/\/$/, "")}/chat/completions`;
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
          messages,
          stream: false,
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`OpenAI API error: ${response.statusText} ${errText}`);
      }

      const data: unknown = await response.json();
      const content = parseOpenAiChatContent(data);
      if (content === null) {
        throw new Error("Invalid response from OpenAI-compatible chat API");
      }
      return content;
    }

    case "gemini": {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const systemMsg = messages.find((m) => m.role === "system")?.content;
      const conversationMsgs = messages.filter((m) => m.role !== "system");

      const contents: GeminiContent[] = conversationMsgs.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

      const body: GeminiRequest = systemMsg
        ? { contents, systemInstruction: { parts: [{ text: systemMsg }] } }
        : { contents };

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`Gemini API error: ${response.statusText} ${errText}`);
      }

      const data: unknown = await response.json();
      const content = parseGeminiChatContent(data);
      if (content === null) {
        throw new Error("Invalid response from Gemini chat API");
      }
      return content;
    }

    case "anthropic": {
      const url = "https://api.anthropic.com/v1/messages";
      const systemMsg = messages.find((m) => m.role === "system")?.content;
      const conversationMsgs = messages.filter((m) => m.role !== "system");

      const anthropicMessages: AnthropicMessage[] = conversationMsgs.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));
      const body: AnthropicRequest = systemMsg
        ? { model, max_tokens: 4000, messages: anthropicMessages, system: systemMsg }
        : { model, max_tokens: 4000, messages: anthropicMessages };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "dangerously-allow-browser": "true",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`Anthropic API error: ${response.statusText} ${errText}`);
      }

      const data: unknown = await response.json();
      const content = parseAnthropicChatContent(data);
      if (content === null) {
        throw new Error("Invalid response from Anthropic chat API");
      }
      return content;
    }

    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}
