import { useEffect } from "react";
import { vaultApi } from "../../api";
import { isDesktopRuntime } from "../../api/dialog";
import type { LlmProvider } from "../../api/types";
import { apiKeysCache, hasTauriInternals } from "../llmSecrets";
import { getStartupVaultPath } from "../vaultStartup";

type AppStartupOptions = {
  readonly openVault: (path: string) => Promise<void> | void;
};

const STARTUP_KEY_PROVIDERS: readonly LlmProvider[] = [
  "openai",
  "anthropic",
  "gemini",
  "ollama",
  "lm-studio",
  "custom",
] as const;

export function useAppStartup({ openVault }: AppStartupOptions) {
  useEffect(() => {
    async function init() {
      if (hasTauriInternals()) {
        for (const provider of STARTUP_KEY_PROVIDERS) {
          try {
            const key = await vaultApi.getApiKey(provider);
            if (key) {
              apiKeysCache[provider] = key;
            }
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            console.error(`Failed to load key for ${provider}: ${detail}`);
          }
        }
      }

      void openVault(getStartupVaultPath(window.localStorage, isDesktopRuntime()));
    }

    void init();
  }, []);
}
