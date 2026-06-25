import { useCallback, useRef, useState } from "react";
import { vaultApi } from "../../api";
import { sendChatMessage } from "../../api/llm";
import type {
  AiProvenance,
  LlmConfig,
  ReviewQueueItem,
  SaveResult,
  SourceMutationResult,
  SourceMutationWarning,
} from "../../api/types";
import { buildMaintenancePrompt } from "../../core/maintenancePrompts";
import { addManagedLink } from "../../core/markdown";

export interface MaintenanceSuggestionEntry {
  readonly proposed: string;
  readonly provenance: AiProvenance;
  readonly generatedAt: string;
}

export interface UseMaintenancePlannerResult {
  readonly generating: Set<string>;
  readonly errors: Record<string, string>;
  readonly suggestions: Record<string, string>;
  readonly provenances: Record<string, AiProvenance>;
  readonly generate: (item: ReviewQueueItem, llmConfig: LlmConfig) => Promise<void>;
  readonly apply: (item: ReviewQueueItem) => Promise<SourceMutationResult>;
  readonly hydrate: (raw: Record<string, MaintenanceSuggestionEntry>) => void;
  readonly clearSuggestion: (itemId: string) => void;
}

export class MaintenanceApplyError extends Error {
  readonly code: "missing_suggestion" | "unsupported" | "zero_changes";
  readonly warnings: readonly SourceMutationWarning[];

  constructor(code: MaintenanceApplyError["code"], message: string, warnings: readonly SourceMutationWarning[] = []) {
    super(message);
    this.name = "MaintenanceApplyError";
    this.code = code;
    this.warnings = warnings;
  }
}

class MaintenanceSaveError extends Error {
  readonly name = "MaintenanceSaveError";

  constructor(readonly path: string, readonly saveResult: SaveResult) {
    super(`Save did not complete for ${path}: conflict=${saveResult.conflict}, snapshot=${saveResult.snapshotId ?? "none"}`);
  }
}

async function readNoteExcerpt(path: string): Promise<string> {
  const document = await vaultApi.readNote(path);
  return document.content.slice(0, 1500);
}

function warning(code: SourceMutationWarning["code"], path: string, error: unknown): SourceMutationWarning {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    path,
  };
}

function durableSaveResult(path: string, result: SaveResult): void {
  if (result.saved) return;
  throw new MaintenanceSaveError(path, result);
}

export function useMaintenancePlanner(): UseMaintenancePlannerResult {
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const generatingRef = useRef<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});
  const [provenances, setProvenances] = useState<Record<string, AiProvenance>>({});

  const hydrate = useCallback(
    (rawSuggestions: Record<string, MaintenanceSuggestionEntry>) => {
      const nextSuggestions: Record<string, string> = {};
      const nextProvenances: Record<string, AiProvenance> = {};
      for (const [key, entry] of Object.entries(rawSuggestions)) {
        nextSuggestions[key] = entry.proposed;
        nextProvenances[key] = entry.provenance;
      }
      setSuggestions(nextSuggestions);
      setProvenances(nextProvenances);
    },
    [],
  );

  const clearSuggestion = useCallback((itemId: string) => {
    setSuggestions((previous) => {
      const next = { ...previous };
      delete next[itemId];
      return next;
    });
    setProvenances((previous) => {
      const next = { ...previous };
      delete next[itemId];
      return next;
    });
  }, []);

  const generate = useCallback(
    async (item: ReviewQueueItem, llmConfig: LlmConfig) => {
      if (!item.suggestionKind || generatingRef.current.has(item.id)) return;
      generatingRef.current.add(item.id);
      setGenerating((previous) => new Set(previous).add(item.id));
      setErrors((previous) => {
        const next = { ...previous };
        delete next[item.id];
        return next;
      });

      try {
        let candidates: string[] = [];
        if (item.suggestionKind === "link_candidates" || item.suggestionKind === "backlinks_in") {
          try {
            const raw = await vaultApi.getContextBundleCandidates(item.path);
            candidates = raw.slice(0, 10).map((candidate) => candidate.title);
          } catch (error) {
            console.warn(
              "Maintenance candidates unavailable",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        const prompt = buildMaintenancePrompt(
          item.suggestionKind,
          item.path,
          await readNoteExcerpt(item.path),
          candidates,
        );
        const proposed = await sendChatMessage(llmConfig, [{ role: "user", content: prompt }]);
        const provenance: AiProvenance = {
          source: "maintenance_planner",
          model: llmConfig.model,
          appliedAt: new Date().toISOString(),
        };
        setSuggestions((previous) => ({ ...previous, [item.id]: proposed }));
        setProvenances((previous) => ({ ...previous, [item.id]: provenance }));

        try {
          const config = await vaultApi.getVaultConfig();
          const entry: MaintenanceSuggestionEntry = {
            proposed,
            provenance,
            generatedAt: provenance.appliedAt ?? new Date().toISOString(),
          };
          await vaultApi.saveVaultConfig({
            ...config,
            maintenanceSuggestions: {
              ...config.maintenanceSuggestions,
              [item.id]: entry,
              [`${item.path}::${item.suggestionKind}`]: entry,
            },
          });
        } catch (error) {
          console.warn("Maintenance suggestion persistence failed", error instanceof Error ? error.message : String(error));
        }
      } catch (error) {
        setErrors((previous) => ({
          ...previous,
          [item.id]: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        generatingRef.current.delete(item.id);
        setGenerating((previous) => {
          const next = new Set(previous);
          next.delete(item.id);
          return next;
        });
      }
    },
    [],
  );

  const apply = useCallback(
    async (item: ReviewQueueItem): Promise<SourceMutationResult> => {
      const proposed = suggestions[item.id];
      if (!proposed) {
        throw new MaintenanceApplyError(
          "missing_suggestion",
          "No suggestion generated yet for this item",
        );
      }
      if (
        !item.suggestionKind ||
        item.suggestionKind === "split" ||
        item.suggestionKind === "merge_or_delete"
      ) {
        throw new MaintenanceApplyError(
          "unsupported",
          `apply() is not supported for suggestionKind: ${item.suggestionKind}`,
        );
      }
      const provenance = provenances[item.id];
      const appliedAt = new Date().toISOString();
      const auditPath = async (path: string): Promise<SourceMutationWarning | null> => {
        try {
          await vaultApi.appendAiAudit({
            editId: item.id,
            editType: "update",
            path,
            source: "maintenance_planner",
            model: provenance?.model,
            appliedAt,
          });
          return null;
        } catch (error) {
          return warning("post_action_failed", path, error instanceof Error ? error : new Error(String(error)));
        }
      };

      if (item.suggestionKind === "summary" || item.kind === "missing_summary") {
        await vaultApi.applyNoteMetadata(item.path, { summary: proposed }, []);
        const auditWarning = await auditPath(item.path);
        return {
          changedPaths: [item.path],
          warnings: auditWarning ? [auditWarning] : [],
        };
      }

      if (item.suggestionKind === "link_candidates" || item.suggestionKind === "backlinks_in") {
        const candidates = await vaultApi.getContextBundleCandidates(item.path);
        const changedPaths: string[] = [];
        const warnings: SourceMutationWarning[] = [];
        const target = item.path.replace(/\.md$/i, "");
        for (const candidate of candidates) {
          try {
            const document = await vaultApi.readNote(candidate.path);
            durableSaveResult(candidate.path, await vaultApi.saveNote(
              candidate.path,
              addManagedLink(document.content, target),
              document.revision,
            ));
            changedPaths.push(candidate.path);
            const auditWarning = await auditPath(candidate.path);
            if (auditWarning) warnings.push(auditWarning);
          } catch (error) {
            warnings.push(warning("partial_failure", candidate.path, error instanceof Error ? error : new Error(String(error))));
          }
        }
        if (changedPaths.length === 0) {
          throw new MaintenanceApplyError("zero_changes", "No maintenance target was updated", warnings);
        }
        return { changedPaths, warnings };
      }

      if (item.suggestionKind === "review_prompt") {
        await vaultApi.applyNoteMetadata(item.path, { reviewRequestedAt: appliedAt }, []);
        const auditWarning = await auditPath(item.path);
        return {
          changedPaths: [item.path],
          warnings: auditWarning ? [auditWarning] : [],
        };
      }

      throw new MaintenanceApplyError(
        "unsupported",
        `apply() is not supported for suggestionKind: ${item.suggestionKind}`,
      );
    },
    [provenances, suggestions],
  );

  return { generating, errors, suggestions, provenances, generate, apply, hydrate, clearSuggestion };
}
