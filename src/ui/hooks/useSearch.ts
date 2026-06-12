import { useState } from "react";
import { vaultApi } from "../../api";
import type { VaultSnapshot } from "../../api/types";
import type { NoteMeta } from "../../core/types";
import type { useEmbeddings } from "./useEmbeddings";

function parsePropertyFilter(value: string): Record<string, string> {
  if (!value.includes("=")) {
    return {};
  }
  const [key, ...rest] = value.split("=");
  return key.trim() ? { [key.trim()]: rest.join("=").trim() } : {};
}

export function useSearch(vault: VaultSnapshot | null, embeddingsHook: ReturnType<typeof useEmbeddings>) {
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [propertyFilter, setPropertyFilter] = useState("");
  const [results, setResults] = useState<(NoteMeta & { similarity?: number })[]>([]);
  const [searchMode, setSearchMode] = useState<"keyword" | "semantic">("keyword");

  async function runSearch(
    nextQuery = query,
    nextTag = tagFilter,
    nextProperty = propertyFilter,
    forceMode?: "keyword" | "semantic"
  ) {
    const mode = forceMode || searchMode;
    if (mode === "semantic") {
      await embeddingsHook.runSemanticSearch(nextQuery, setResults);
    } else {
      embeddingsHook.setSemanticSearchError(null);
      const frontmatter = parsePropertyFilter(nextProperty);
      const notes = await vaultApi.searchNotes({
        query: nextQuery,
        tags: nextTag ? [nextTag] : [],
        frontmatter
      });
      setResults(notes);
    }
  }

  return {
    query,
    setQuery,
    tagFilter,
    setTagFilter,
    propertyFilter,
    setPropertyFilter,
    results,
    setResults,
    searchMode,
    setSearchMode,
    runSearch,
  };
}
