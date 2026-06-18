import { useState, useCallback, useRef } from "react";
import { vaultApi } from "../../api";
import { sendChatMessage } from "../../api/llm";
import { buildMaintenancePrompt } from "../../core/maintenancePrompts";
import { addManagedLink } from "../../core/markdown";
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
  apply: (item: ReviewQueueItem) => Promise<string[]>;
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
    async (item: ReviewQueueItem): Promise<string[]> => {
      const proposed = suggestions[item.id];
      if (!proposed) {
        throw new Error("No suggestion generated yet for this item");
      }

      const provenance = provenances[item.id];
      const appliedAt = new Date().toISOString();

      const auditPath = async (path: string) => {
        try {
          await vaultApi.appendAiAudit({
            editId: item.id,
            editType: "update",
            path,
            source: "maintenance_planner",
            model: provenance?.model,
            appliedAt,
          });
        } catch {
          // audit failure is non-fatal
        }
      };

      if (item.suggestionKind === "summary" || item.kind === "missing_summary") {
        await vaultApi.applyNoteMetadata(item.path, { summary: proposed }, []);
        await auditPath(item.path);
        item.status = "applied";
        return [item.path];
      }

      if (item.suggestionKind === "link_candidates") {
        const doc = await vaultApi.readNote(item.path);
        const updatedContent = addManagedLink(doc.content, item.title);
        await vaultApi.saveNote(item.path, updatedContent, doc.revision);
        await auditPath(item.path);
        item.status = "applied";
        return [item.path];
      }

      if (item.suggestionKind === "backlinks_in") {
        const candidates = await vaultApi.getContextBundleCandidates(item.path);
        const succeeded: string[] = [];
        for (const candidate of candidates) {
          try {
            const doc = await vaultApi.readNote(candidate.path);
            const updatedContent = addManagedLink(doc.content, item.title);
            await vaultApi.saveNote(candidate.path, updatedContent, doc.revision);
            await auditPath(candidate.path);
            succeeded.push(candidate.path);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setErrors((prev) => ({ ...prev, [item.id]: msg }));
            if (succeeded.length > 0) {
              item.status = "applied";
            }
            return succeeded;
          }
        }
        item.status = "applied";
        return succeeded;
      }

      if (item.suggestionKind === "review_prompt") {
        await vaultApi.applyNoteMetadata(item.path, { reviewRequestedAt: appliedAt }, []);
        await auditPath(item.path);
        item.status = "applied";
        return [item.path];
      }

      throw new Error(`apply() is not supported for suggestionKind: ${item.suggestionKind}`);
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
