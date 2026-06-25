import { vaultApi } from "../api";
import type { LlmConfig, LlmProvider } from "../api/types";

export async function computeHash(content: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(12, "0").slice(0, 12);
  }
  const msgBuffer = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  return hashHex.slice(0, 12);
}

function llmApiKeyStorageKey(provider: LlmProvider): string {
  return `lattice:llm-api-key:${provider}`;
}

export const apiKeysCache: Record<string, string> = {};

export function hasTauriInternals(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

export function readStoredLlmApiKey(provider: LlmProvider): string {
  if (hasTauriInternals()) {
    return apiKeysCache[provider] || "";
  }
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return window.localStorage.getItem(llmApiKeyStorageKey(provider)) || "";
  } catch {
    return "";
  }
}

export function saveStoredLlmApiKey(provider: LlmProvider, apiKey: string): void {
  const key = apiKey.trim();
  apiKeysCache[provider] = key;
  if (hasTauriInternals()) {
    void vaultApi.saveApiKey(provider, key);
    return;
  }
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (key) {
      window.localStorage.setItem(llmApiKeyStorageKey(provider), key);
    } else {
      window.localStorage.removeItem(llmApiKeyStorageKey(provider));
    }
  } catch {
    // localStorage may be unavailable in hardened or test environments.
  }
}

export function hydrateLlmConfigSecrets(config: LlmConfig): LlmConfig {
  return { ...config, apiKey: readStoredLlmApiKey(config.provider) || config.apiKey || "" };
}
