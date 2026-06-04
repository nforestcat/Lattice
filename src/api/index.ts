import { createMockVaultApi } from "./mockVault";
import { createTauriVaultApi } from "./tauriVault";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const vaultApi = window.__TAURI_INTERNALS__ ? createTauriVaultApi() : createMockVaultApi();
