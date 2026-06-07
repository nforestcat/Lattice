import type { LlmConfig } from "./types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function sendChatMessage(
  config: LlmConfig,
  messages: ChatMessage[]
): Promise<string> {
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

      const data = await response.json();
      return data.message?.content || "";
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

      const data = await response.json();
      return data.choices?.[0]?.message?.content || "";
    }

    case "gemini": {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const systemMsg = messages.find((m) => m.role === "system")?.content;
      const conversationMsgs = messages.filter((m) => m.role !== "system");

      const contents = conversationMsgs.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

      const body: any = { contents };
      if (systemMsg) {
        body.systemInstruction = {
          parts: [{ text: systemMsg }],
        };
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`Gemini API error: ${response.statusText} ${errText}`);
      }

      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }

    case "anthropic": {
      const url = "https://api.anthropic.com/v1/messages";
      const systemMsg = messages.find((m) => m.role === "system")?.content;
      const conversationMsgs = messages.filter((m) => m.role !== "system");

      const body: any = {
        model,
        max_tokens: 4000,
        messages: conversationMsgs.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
        })),
      };

      if (systemMsg) {
        body.system = systemMsg;
      }

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

      const data = await response.json();
      return data.content?.[0]?.text || "";
    }

    default:
      throw new Error(`Unsupported LLM provider: ${provider}`);
  }
}
