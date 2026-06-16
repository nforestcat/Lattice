import { useState, useCallback, useRef } from "react";
import { vaultApi } from "../../api";
import { sendChatMessage } from "../../api/llm";
import { buildMaintenancePrompt } from "../../core/maintenancePrompts";
import type {
  AiProvenance,
  LlmConfig,
  ReviewQueueItem,
} from "../../api/types";

export interface MaintenanceSuggestionEntry {
  proposed: string;
  provenance: AiProvenance;
  generatedAt: string;
}

export interface UseMaintenancePlannerResult {
  generating: Set<string>;
  errors: Record<string, string>;
  suggestions: Record<string, string>;
  provenances: Record<string, AiProvenance>;
  generate: (item: ReviewQueueItem, llmConfig: LlmConfig) => Promise<void>;
  apply: (item: ReviewQueueItem) => Promise<void>;
  hydrate: (rawSuggestions: Record<string, MaintenanceSuggestionEntry>) => void;
  clearSuggestion: (itemId: string) => void;
}

async function readNoteExcerpt(path: string): Promise<string> {
  const doc = await vaultApi.readNote(path);
  return doc.content.slice(0, 1500);
}

export function useMaintenancePlanner(): UseMaintenancePlannerResult {
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const generatingRef = useRef<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});
  const [provenances, setProvenances] = useState<Record<string, AiProvenance>>({});

  const hydrate = useCallback(
    (rawSuggestions: Record<string, MaintenanceSuggestionEntry>) => {
      const newSuggestions: Record<string, string> = {};
      const newProvenances: Record<string, AiProvenance> = {};
      for (const [key, entry] of Object.entries(rawSuggestions)) {
        newSuggestions[key] = entry.proposed;
        newProvenances[key] = entry.provenance;
      }
      setSuggestions(newSuggestions);
      setProvenances(newProvenances);
    },
    []
  );

  const clearSuggestion = useCallback((itemId: string) => {
    setSuggestions((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
    setProvenances((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }, []);

  const generate = useCallback(
    async (item: ReviewQueueItem, llmConfig: LlmConfig) => {
      if (!item.suggestionKind) return;
      if (generatingRef.current.has(item.id)) return;

      generatingRef.current.add(item.id);
      setGenerating((prev) => new Set(prev).add(item.id));
      setErrors((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });

      try {
        let candidates: string[] = [];
        if (
          item.suggestionKind === "link_candidates" ||
          item.suggestionKind === "backlinks_in"
        ) {
          try {
            const raw = await vaultApi.getContextBundleCandidates(item.path);
            candidates = raw.slice(0, 10).map((c) => c.title);
          } catch {
            // non-fatal — proceed without candidates
          }
        }

        const noteExcerpt = await readNoteExcerpt(item.path);

        const prompt = buildMaintenancePrompt(
          item.suggestionKind,
          item.path,
          noteExcerpt,
          candidates
        );

        const result = await sendChatMessage(llmConfig, [
          { role: "user", content: prompt },
        ]);

        const provenance: AiProvenance = {
          source: "maintenance_planner",
          model: llmConfig.model,
          appliedAt: new Date().toISOString(),
        };

        setSuggestions((prev) => ({ ...prev, [item.id]: result }));
        setProvenances((prev) => ({ ...prev, [item.id]: provenance }));

        // Persist to vault config under both item.id and path::suggestionKind
        try {
          const config = await vaultApi.getVaultConfig();
          const existing = config.maintenanceSuggestions ?? {};
          const entry: MaintenanceSuggestionEntry = {
            proposed: result,
            provenance,
            generatedAt: provenance.appliedAt ?? new Date().toISOString(),
          };
          const persistKey = `${item.path}::${item.suggestionKind}`;
          await vaultApi.saveVaultConfig({
            ...config,
            maintenanceSuggestions: {
              ...existing,
              [item.id]: entry,
              [persistKey]: entry,
            },
          });
        } catch {
          // persistence failure is non-fatal
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setErrors((prev) => ({ ...prev, [item.id]: msg }));
      } finally {
        generatingRef.current.delete(item.id);
        setGenerating((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
    },
    []
  );

  const apply = useCallback(
    async (item: ReviewQueueItem) => {
      if (item.kind !== "missing_summary") {
        throw new Error(`apply() is only supported for missing_summary items, got: ${item.kind}`);
      }

      const proposed = suggestions[item.id];
      if (!proposed) {
        throw new Error("No suggestion generated yet for this item");
      }

      const provenance = provenances[item.id];

      await vaultApi.applyNoteMetadata(item.path, { summary: proposed }, []);

      try {
        await vaultApi.appendAiAudit({
          editId: item.id,
          editType: "update",
          path: item.path,
          source: "maintenance_planner",
          model: provenance?.model,
          appliedAt: new Date().toISOString(),
        });
      } catch {
        // audit failure is non-fatal
      }
    },
    [suggestions, provenances]
  );

  return {
    generating,
    errors,
    suggestions,
    provenances,
    generate,
    apply,
    hydrate,
    clearSuggestion,
  };
}
