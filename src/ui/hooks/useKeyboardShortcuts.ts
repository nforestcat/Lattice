import { keymap, type KeyBinding } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { NoteMeta } from "../../core/types";

type ViewMode = "split" | "edit" | "preview" | "graph" | "distill";
type Shortcut =
  | "save"
  | "previous-note"
  | "next-note"
  | { readonly viewMode: ViewMode };

interface KeyboardShortcutActions {
  readonly activePath: string | null;
  readonly notes: readonly NoteMeta[];
  readonly saveActiveNote: () => Promise<void> | void;
  readonly selectNote: (path: string) => Promise<void> | void;
  readonly setViewMode: (mode: ViewMode) => void;
}

const VIEW_SHORTCUTS: Readonly<Record<string, ViewMode>> = {
  "1": "split",
  "2": "edit",
  "3": "preview",
  "4": "graph",
  "5": "distill",
};

function resolveShortcut(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">): Shortcut | null {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
    return "save";
  }
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (event.key === "ArrowUp") {
    return "previous-note";
  }
  if (event.key === "ArrowDown") {
    return "next-note";
  }
  const viewMode = VIEW_SHORTCUTS[event.key];
  return viewMode ? { viewMode } : null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

export function useKeyboardShortcuts(actions: KeyboardShortcutActions) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const runShortcut = useCallback((shortcut: Shortcut): boolean => {
    const current = actionsRef.current;
    if (shortcut === "save") {
      void current.saveActiveNote();
      return true;
    }
    if (typeof shortcut === "object") {
      current.setViewMode(shortcut.viewMode);
      return true;
    }
    if (current.notes.length === 0) {
      return true;
    }

    const activeIndex = current.notes.findIndex((note) => note.path === current.activePath);
    const offset = shortcut === "previous-note" ? -1 : 1;
    const startIndex = activeIndex === -1
      ? (offset === 1 ? -1 : 0)
      : activeIndex;
    const nextIndex = (startIndex + offset + current.notes.length) % current.notes.length;
    const nextNote = current.notes[nextIndex];
    if (nextNote) {
      void current.selectNote(nextNote.path);
    }
    return true;
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const shortcut = resolveShortcut(event);
      if (!shortcut || (shortcut !== "save" && isEditableTarget(event.target))) {
        return;
      }
      event.preventDefault();
      runShortcut(shortcut);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [runShortcut]);

  return useMemo(() => {
    const bindings: readonly KeyBinding[] = [
      { key: "Mod-s", run: () => runShortcut("save") },
      { key: "Alt-1", run: () => runShortcut({ viewMode: "split" }) },
      { key: "Alt-2", run: () => runShortcut({ viewMode: "edit" }) },
      { key: "Alt-3", run: () => runShortcut({ viewMode: "preview" }) },
      { key: "Alt-4", run: () => runShortcut({ viewMode: "graph" }) },
      { key: "Alt-5", run: () => runShortcut({ viewMode: "distill" }) },
      { key: "Alt-ArrowUp", run: () => runShortcut("previous-note") },
      { key: "Alt-ArrowDown", run: () => runShortcut("next-note") },
    ];
    return keymap.of(bindings);
  }, [runShortcut]);
}
