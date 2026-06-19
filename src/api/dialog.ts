import { confirm, open } from "@tauri-apps/plugin-dialog";
import { isDesktopRuntime } from "./runtime";

export { isDesktopRuntime };

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

// --- askInput: imperative promise bridge ---

export interface InputDialogOptions {
  title?: string;
  defaultValue?: string;
  placeholder?: string;
}

export interface InputDialogRequest {
  message: string;
  options: InputDialogOptions;
  resolve: (value: string | null) => void;
}

type InputDialogOpener = (request: InputDialogRequest) => void;

let registeredOpener: InputDialogOpener | null = null;
let pendingResolve: ((value: string | null) => void) | null = null;

export function registerInputDialog(opener: InputDialogOpener): void {
  registeredOpener = opener;
}

export function unregisterInputDialog(): void {
  registeredOpener = null;
  if (pendingResolve) {
    pendingResolve(null);
    pendingResolve = null;
  }
}

export function askInput(message: string, options?: InputDialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (!registeredOpener) {
      console.warn("[askInput] No InputDialogHost mounted");
      resolve(null);
      return;
    }
    if (pendingResolve) {
      pendingResolve(null);
    }
    pendingResolve = resolve;
    registeredOpener({ message, options: options || {}, resolve });
  });
}
