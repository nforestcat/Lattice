import { confirm, open } from "@tauri-apps/plugin-dialog";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isDesktopRuntime(): boolean {
  return Boolean(window.__TAURI_INTERNALS__);
}

export async function pickVaultFolder(): Promise<string | null> {
  if (!isDesktopRuntime()) {
    return null;
  }

  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open Lattice vault"
  });

  return typeof selected === "string" ? selected : null;
}

export async function askConfirm(message: string, title?: string): Promise<boolean> {
  if (isDesktopRuntime()) {
    return confirm(message, {
      title: title || "Confirm Action",
      kind: "warning"
    });
  }
  return window.confirm(message);
}
