import { useState } from "react";
import type { ReactCodeMirrorRef } from "@uiw/react-codemirror";
import type {
  BacklinkSuggestion,
  SourceMutationResult,
  SourceMutationWarning,
  VaultSnapshot,
} from "../../api/types";
import type { NoteMeta } from "../../core/types";
import { vaultApi } from "../../api";

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceUnlinkedMentions(content: string, text: string): string {
  const escaped = escapeRegExp(text);
  const wordPattern = new RegExp(`(?<![\\p{L}\\p{N}_])(${escaped})(?![\\p{L}\\p{N}_])`, "giu");
  return content
    .split(/(\[\[[^\]]+\]\])/g)
    .map((segment) => {
      if (segment.startsWith("[[") && segment.endsWith("]]")) {
        return segment;
      }
      return segment.replace(wordPattern, "[[$1]]");
    })
    .join("");
}

export interface UseLinkSuggestionsCallbacks {
  activePath: string | null;
  draft: string;
  setDraft: (updater: string | ((prev: string) => string)) => void;
  vault: VaultSnapshot | null;
  setVault: React.Dispatch<React.SetStateAction<VaultSnapshot | null>>;
  setStatus: (status: string) => void;
  editorRef: React.RefObject<ReactCodeMirrorRef | null>;
}

export function useLinkSuggestions(callbacks: UseLinkSuggestionsCallbacks) {
  const { activePath, draft, setDraft, vault, setVault, setStatus, editorRef } = callbacks;

  const [linkSuggestions, setLinkSuggestions] = useState<{ text: string; path: string }[]>([]);
  const [backlinkSuggestions, setBacklinkSuggestions] = useState<BacklinkSuggestion[]>([]);
  const [isLoadingBacklinkSuggestions, setIsLoadingBacklinkSuggestions] = useState(false);

  function updateLinkSuggestions(content: string, notes: NoteMeta[]) {
    if (!activePath) {
      setLinkSuggestions([]);
      return;
    }

    const suggestions: { text: string; path: string }[] = [];
    for (const note of notes) {
      if (note.path === activePath) {
        continue;
      }
      const title = note.title.trim();
      if (!title) {
        continue;
      }

      const escaped = escapeRegExp(title);
      const maskedText = content.replace(/\[\[[^\]]+\]\]/g, "####LINK####");
      const wordPattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
      if (wordPattern.test(maskedText)) {
        suggestions.push({ text: title, path: note.path });
      }
    }
    setLinkSuggestions(suggestions);
  }

  function applyWikiLinkSuggestion(text: string) {
    if (!draft) return;
    const nextDraft = replaceUnlinkedMentions(draft, text);
    setDraft(nextDraft);
    if (vault?.notes) {
      updateLinkSuggestions(nextDraft, vault.notes);
    }
  }

  const insertWikiLinkAtCursor = (title: string) => {
    const view = editorRef.current?.view;
    if (view) {
      const linkText = `[[${title}]]`;
      const transaction = view.state.update({
        changes: {
          from: view.state.selection.main.from,
          to: view.state.selection.main.to,
          insert: linkText
        },
        selection: { anchor: view.state.selection.main.from + linkText.length },
        scrollIntoView: true
      });
      view.dispatch(transaction);
      view.focus();
    } else {
      setDraft(prev => prev + ` [[${title}]]`);
    }
  };

  async function refreshBacklinkSuggestions(path: string) {
    setIsLoadingBacklinkSuggestions(true);
    try {
      const suggestions = await vaultApi.getBacklinkSuggestions(path);
      setBacklinkSuggestions(suggestions);
    } catch (error) {
      console.error(
        "Failed to fetch backlink suggestions",
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      setIsLoadingBacklinkSuggestions(false);
    }
  }

  async function applyBacklinkSuggestion(
    suggestion: BacklinkSuggestion,
    refreshContext: (path: string) => Promise<void>,
    runHealthAudit: () => Promise<void>,
  ): Promise<SourceMutationResult> {
    setStatus(`Applying backlink suggestion from ${suggestion.sourceTitle}...`);
    try {
      await vaultApi.applyBacklinkSuggestion(suggestion);
    } catch (error) {
      console.error("Failed to apply backlink suggestion", error);
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }

    const warnings: SourceMutationWarning[] = [];
    const recordWarning = (error: unknown) => {
      warnings.push({
        code: "post_action_failed",
        message: error instanceof Error ? error.message : String(error),
        path: suggestion.sourcePath,
      });
    };
    setStatus("Applied backlink suggestion!");
    if (vault) {
      try {
        const nextVault = await vaultApi.openVault(vault.rootPath);
        setVault(nextVault);
      } catch (error) {
        recordWarning(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (activePath) {
      try {
        await refreshContext(activePath);
      } catch (error) {
        recordWarning(error instanceof Error ? error : new Error(String(error)));
      }
      try {
        setBacklinkSuggestions(await vaultApi.getBacklinkSuggestions(activePath));
      } catch (error) {
        recordWarning(error instanceof Error ? error : new Error(String(error)));
      }
    }
    try {
      await runHealthAudit();
    } catch (error) {
      recordWarning(error instanceof Error ? error : new Error(String(error)));
    }
    return { changedPaths: [suggestion.sourcePath], warnings };
  }

  return {
    linkSuggestions, setLinkSuggestions,
    backlinkSuggestions, setBacklinkSuggestions,
    isLoadingBacklinkSuggestions, setIsLoadingBacklinkSuggestions,
    updateLinkSuggestions,
    applyWikiLinkSuggestion,
    insertWikiLinkAtCursor,
    refreshBacklinkSuggestions,
    applyBacklinkSuggestion,
  };
}
