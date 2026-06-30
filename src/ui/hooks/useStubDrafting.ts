import { useState } from "react";
import { vaultApi } from "../../api";
import { sendChatMessage, type ChatMessage } from "../../api/llm";
import type {
  LlmConfig,
  SaveResult,
  SourceMutationResult,
  SourceMutationWarning,
  StubDraftReview,
  UnresolvedLinkGroup,
  UnresolvedLinkSource,
  VaultSnapshot,
} from "../../api/types";
import { normalizeRef } from "../../core/normalizeRef";
import type { UnresolvedLinksState } from "./useUnresolvedLinks";

export interface UseStubDraftingCallbacks {
  readonly llmConfig: LlmConfig;
  readonly vault: VaultSnapshot | null;
  readonly activePath: string | null;
  readonly setStatus: (status: string) => void;
  readonly refreshVault: (path: string | null) => Promise<void>;
  readonly unresolved: UnresolvedLinksState;
}

class StubDraftApplyError extends Error {
  readonly code: "draft_not_ready" | "missing_created_path" | "save_not_durable";
  readonly path: string | undefined;
  readonly saveResult: SaveResult | undefined;

  constructor(
    code: StubDraftApplyError["code"],
    message: string,
    details?: { readonly path: string; readonly saveResult: SaveResult },
  ) {
    super(message);
    this.name = "StubDraftApplyError";
    this.code = code;
    this.path = details?.path;
    this.saveResult = details?.saveResult;
  }
}

function warningFor(error: unknown, path: string): SourceMutationWarning {
  return {
    code: "post_action_failed",
    message: error instanceof Error ? error.message : String(error),
    path,
  };
}

function durableSaveResult(path: string, result: SaveResult): void {
  if (result.saved) return;
  throw new StubDraftApplyError(
    "save_not_durable",
    `Save did not complete for ${path}: conflict=${result.conflict}, snapshot=${result.snapshotId ?? "none"}`,
    { path, saveResult: result },
  );
}

async function requestStubDraft(
  config: LlmConfig,
  target: string,
  sources: readonly UnresolvedLinkSource[],
): Promise<string> {
  const sourceInfo = sources
    .map((source) => `Note: "${source.title}"\nContext Excerpt:\n${source.excerpt}`)
    .join("\n\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "You are an expert wiki editor. Please write a short, concise, and high-quality stub note (in Markdown) defining the term. Do not include a heading for the title, just write the body text with appropriate formatting.",
    },
    {
      role: "user",
      content: `We have an unresolved wiki link to the note "${target}". It is referenced in the following contexts:\n\n${sourceInfo}\n\nPlease write a concise defining stub note (in Markdown) for "${target}" based on this context.`,
    },
  ];
  return sendChatMessage(config, messages);
}

export function useStubDrafting(callbacks: UseStubDraftingCallbacks) {
  const {
    llmConfig,
    vault,
    activePath,
    setStatus,
    refreshVault,
    unresolved,
  } = callbacks;
  const {
    unresolvedLinks,
    setUnresolvedLinks,
    isScanningUnresolved: _,
    setIsScanningUnresolved,
    selectedUnresolvedTargets,
    setSelectedUnresolvedTargets,
    activeUnresolvedTarget,
    setActiveUnresolvedTarget,
  } = unresolved;
  const [draftingTarget, setDraftingTarget] = useState<string | null>(null);
  const [draftedContent, setDraftedContent] = useState<string | null>(null);
  const [bulkDrafts, setBulkDrafts] = useState<Record<string, StubDraftReview>>({});
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);

  async function runUnresolvedLinksScan(): Promise<UnresolvedLinkGroup[]> {
    setIsScanningUnresolved(true);
    setUnresolvedLinks([]);
    setDraftingTarget(null);
    setDraftedContent(null);
    try {
      const links = await vaultApi.getUnresolvedLinks();
      setUnresolvedLinks(links);
      setStatus(`Scan complete: found ${links.length} unresolved link(s)`);
      return links;
    } catch (error) {
      console.error(error instanceof Error ? error : new Error(String(error)));
      setStatus("Failed to scan unresolved links");
      return [];
    } finally {
      setIsScanningUnresolved(false);
    }
  }

  async function draftStubNote(
    target: string,
    sources: readonly UnresolvedLinkSource[],
  ): Promise<void> {
    if (
      !llmConfig.provider
      || (
        !llmConfig.apiKey
        && llmConfig.provider !== "ollama"
        && llmConfig.provider !== "lm-studio"
      )
    ) {
      setStatus("Please configure LLM settings first");
      return;
    }
    setBulkDrafts((previous) => ({
      ...previous,
      [target]: { content: "", status: "drafting" },
    }));
    setSelectedUnresolvedTargets((previous) => new Set(previous).add(target));
    try {
      const content = await requestStubDraft(llmConfig, target, sources);
      setBulkDrafts((previous) => ({
        ...previous,
        [target]: { content, status: "done" },
      }));
      setStatus(`Drafted AI stub for "${target}"`);
    } catch (error) {
      console.error(error instanceof Error ? error : new Error(String(error)));
      setBulkDrafts((previous) => ({
        ...previous,
        [target]: { content: "", status: "error" },
      }));
      setStatus("Failed to draft AI stub");
    }
  }

  async function runBulkDrafting(): Promise<void> {
    const targets = [...selectedUnresolvedTargets].filter(
      (target) => bulkDrafts[target]?.status !== "done",
    );
    if (targets.length === 0) {
      setStatus("No new stubs to draft");
      return;
    }
    setIsBulkProcessing(true);
    setStatus(`Bulk drafting ${targets.length} stub(s)...`);
    for (const target of targets) {
      const group = unresolvedLinks.find((candidate) => candidate.target === target);
      if (group) await draftStubNote(target, group.sources);
    }
    setIsBulkProcessing(false);
    setStatus("Finished bulk drafting stubs");
  }

  async function applyStubDraft(target: string): Promise<SourceMutationResult> {
    const draft = bulkDrafts[target];
    if (!draft || draft.status !== "done") {
      throw new StubDraftApplyError(
        "draft_not_ready",
        `Generated stub draft is not ready: ${target}`,
      );
    }
    const created = await vaultApi.createNote(null, target);
    const createdPath = created.selectedPath;
    if (!createdPath) {
      throw new StubDraftApplyError(
        "missing_created_path",
        `Created stub path is missing: ${target}`,
      );
    }
    try {
      const document = await vaultApi.readNote(createdPath);
      durableSaveResult(
        createdPath,
        await vaultApi.saveNote(createdPath, draft.content, document.revision),
      );
    } catch (error) {
      try {
        await vaultApi.deleteEntry(createdPath);
      } catch (rollbackError) {
        if (rollbackError instanceof Error) console.warn("Failed to rollback stub note", rollbackError.message);
        else console.warn("Failed to rollback stub note", String(rollbackError));
      }
      throw error;
    }

    setBulkDrafts((previous) => {
      const next = { ...previous };
      delete next[target];
      return next;
    });
    setSelectedUnresolvedTargets((previous) => {
      const next = new Set(previous);
      next.delete(target);
      return next;
    });
    if (activeUnresolvedTarget && normalizeRef(target) === activeUnresolvedTarget) {
      setActiveUnresolvedTarget(null);
    }

    const warnings: SourceMutationWarning[] = [];
    if (vault) {
      try {
        await refreshVault(activePath);
      } catch (error) {
        warnings.push(
          warningFor(error instanceof Error ? error : new Error(String(error)), createdPath),
        );
      }
    }
    setIsScanningUnresolved(true);
    try {
      setUnresolvedLinks(await vaultApi.getUnresolvedLinks());
    } catch (error) {
      warnings.push(
        warningFor(error instanceof Error ? error : new Error(String(error)), createdPath),
      );
    } finally {
      setIsScanningUnresolved(false);
    }
    setStatus(`Created stub note "${target}"`);
    return { changedPaths: [createdPath], warnings };
  }

  function handleSelectAllToggle(): void {
    const allSelected = unresolvedLinks.every((item) =>
      selectedUnresolvedTargets.has(item.target)
    );
    setSelectedUnresolvedTargets(
      allSelected
        ? new Set()
        : new Set(unresolvedLinks.map((item) => item.target)),
    );
  }

  return { draftingTarget, setDraftingTarget, draftedContent, setDraftedContent, bulkDrafts, setBulkDrafts, isBulkProcessing, runUnresolvedLinksScan, draftStubNote, runBulkDrafting, applyStubDraft, handleSelectAllToggle };
}
