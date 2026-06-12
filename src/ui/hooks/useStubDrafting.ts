import { useState } from "react";
import { vaultApi } from "../../api";
import { sendChatMessage, type ChatMessage } from "../../api/llm";
import type { LlmConfig, StubDraftReview, UnresolvedLinkGroup, UnresolvedLinkSource, VaultSnapshot } from "../../api/types";

function normalizeRef(value: string): string {
  return value.replace(/\\/g, "/").replace(/\.md$/i, "").trim().toLowerCase();
}

export interface UseStubDraftingCallbacks {
  llmConfig: LlmConfig;
  vault: VaultSnapshot | null;
  activePath: string | null;
  setStatus: (status: string) => void;
  refreshVault: (path: string | null) => Promise<void>;
  unresolvedLinks: UnresolvedLinkGroup[];
  setUnresolvedLinks: (links: UnresolvedLinkGroup[]) => void;
  setIsScanningUnresolved: (scanning: boolean) => void;
  activeUnresolvedTarget: string | null;
  setActiveUnresolvedTarget: (target: string | null) => void;
}

export function useStubDrafting(callbacks: UseStubDraftingCallbacks) {
  const {
    llmConfig,
    vault,
    activePath,
    setStatus,
    refreshVault,
    unresolvedLinks,
    setUnresolvedLinks,
    setIsScanningUnresolved,
    activeUnresolvedTarget,
    setActiveUnresolvedTarget,
  } = callbacks;

  const [draftingTarget, setDraftingTarget] = useState<string | null>(null);
  const [draftedContent, setDraftedContent] = useState<string | null>(null);
  const [selectedUnresolvedTargets, setSelectedUnresolvedTargets] = useState<Set<string>>(new Set());
  const [bulkDrafts, setBulkDrafts] = useState<Record<string, StubDraftReview>>({});
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);

  async function runUnresolvedLinksScan() {
    setIsScanningUnresolved(true);
    setUnresolvedLinks([]);
    setDraftingTarget(null);
    setDraftedContent(null);
    try {
      const list = await vaultApi.getUnresolvedLinks();
      setUnresolvedLinks(list);
      setStatus(`Scan complete: found ${list.length} unresolved link(s)`);
      return list;
    } catch (err) {
      console.error(err);
      setStatus("Failed to scan unresolved links");
      return [];
    } finally {
      setIsScanningUnresolved(false);
    }
  }

  async function draftStubNote(targetTitle: string, sources: UnresolvedLinkSource[]) {
    const config = llmConfig;
    if (!config.provider || (!config.apiKey && config.provider !== "ollama" && config.provider !== "lm-studio")) {
      setStatus("Please configure LLM settings first");
      return;
    }

    setBulkDrafts(prev => ({
      ...prev,
      [targetTitle]: { content: "", status: "drafting", approved: true }
    }));
    setSelectedUnresolvedTargets(prev => {
      const next = new Set(prev);
      next.add(targetTitle);
      return next;
    });

    try {
      const sourceInfo = sources.map(s => `Note: "${s.title}"\nContext Excerpt:\n${s.excerpt}`).join("\n\n");
      const systemPrompt = "You are an expert wiki editor. Please write a short, concise, and high-quality stub note (in Markdown) defining the term. Do not include a heading for the title, just write the body text with appropriate formatting.";
      const userPrompt = `We have an unresolved wiki link to the note "${targetTitle}". It is referenced in the following contexts:\n\n${sourceInfo}\n\nPlease write a concise defining stub note (in Markdown) for "${targetTitle}" based on this context.`;

      const payload: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ];

      const response = await sendChatMessage(config, payload);
      setBulkDrafts(prev => ({
        ...prev,
        [targetTitle]: { content: response, status: "done", approved: true }
      }));
      setStatus(`Drafted AI stub for "${targetTitle}"`);
    } catch (err) {
      console.error(err);
      setBulkDrafts(prev => ({
        ...prev,
        [targetTitle]: { content: "", status: "error", approved: false }
      }));
      setStatus("Failed to draft AI stub");
    }
  }

  async function runBulkDrafting() {
    // Preserve approved drafts so user edits are not overwritten, but allow rejected drafts to be regenerated.
    const targets = Array.from(selectedUnresolvedTargets).filter(t => {
      const draft = bulkDrafts[t];
      return !(draft?.status === "done" && draft.approved);
    });
    if (targets.length === 0) {
      setStatus("No new stubs to draft");
      return;
    }

    setIsBulkProcessing(true);
    setStatus(`Bulk drafting ${targets.length} stub(s)...`);

    const nextDrafts = { ...bulkDrafts };
    for (const t of targets) {
      nextDrafts[t] = { content: "", status: "drafting", approved: true };
    }
    setBulkDrafts(nextDrafts);

    const config = llmConfig;

    for (const target of targets) {
      const item = unresolvedLinks.find(x => x.target === target);
      if (!item) continue;

      try {
        const sourceInfo = item.sources.map(s => `Note: "${s.title}"\nContext Excerpt:\n${s.excerpt}`).join("\n\n");
        const systemPrompt = "You are an expert wiki editor. Please write a short, concise, and high-quality stub note (in Markdown) defining the term. Do not include a heading for the title, just write the body text with appropriate formatting.";
        const userPrompt = `We have an unresolved wiki link to the note "${target}". It is referenced in the following contexts:\n\n${sourceInfo}\n\nPlease write a concise defining stub note (in Markdown) for "${target}" based on this context.`;

        const payload: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ];

        const response = await sendChatMessage(config, payload);
        setBulkDrafts(prev => ({
          ...prev,
          [target]: { content: response, status: "done", approved: true }
        }));
      } catch (err) {
        console.error(err);
        setBulkDrafts(prev => ({
          ...prev,
          [target]: { content: "", status: "error", approved: false }
        }));
      }
    }

    setIsBulkProcessing(false);
    setStatus("Finished bulk drafting stubs");
  }

  async function createSelectedStubs() {
    const targets = Array.from(selectedUnresolvedTargets).filter(t => {
      const draft = bulkDrafts[t];
      return draft?.status === "done" && draft?.approved;
    });
    if (targets.length === 0) return;

    setStatus(`Creating ${targets.length} note(s)...`);
    let successCount = 0;
    const createdTargets: string[] = [];
    try {
      for (const target of targets) {
        const draft = bulkDrafts[target];
        if (!draft || draft.status !== "done" || !draft.approved) continue;

        try {
          const result = await vaultApi.createNote(null, target);
          const newPath = result.selectedPath;
          if (newPath) {
            const saveResult = await vaultApi.saveNote(newPath, draft.content, "");
            if (!saveResult.saved) {
              throw new Error("Failed to save stub content");
            }
            successCount++;
            createdTargets.push(target);

            // Clear activeUnresolvedTarget if this created note was the active ghost
            if (activeUnresolvedTarget && normalizeRef(target) === activeUnresolvedTarget) {
              setActiveUnresolvedTarget(null);
            }
          }
        } catch (err) {
          console.error(`Failed to create stub for ${target}:`, err);
        }
      }

      setStatus(`Successfully created ${successCount} stub note(s).`);

      // Keep rejected/unprocessed targets in selection, remove successfully created ones
      const remainingTargets = new Set(selectedUnresolvedTargets);
      createdTargets.forEach(t => remainingTargets.delete(t));
      setSelectedUnresolvedTargets(remainingTargets);

      // Clean up successfully created drafts
      const remainingDrafts = { ...bulkDrafts };
      createdTargets.forEach(t => delete remainingDrafts[t]);
      setBulkDrafts(remainingDrafts);

      if (vault) {
        await refreshVault(activePath);
      }
      void runUnresolvedLinksScan();
    } catch (err) {
      console.error(err);
      setStatus("Failed to create selected stub notes");
    }
  }

  function handleSelectAllToggle() {
    if (selectedUnresolvedTargets.size === unresolvedLinks.length) {
      setSelectedUnresolvedTargets(new Set());
    } else {
      setSelectedUnresolvedTargets(new Set(unresolvedLinks.map(item => item.target)));
    }
  }

  function approveDraft(target: string) {
    setBulkDrafts(prev => prev[target] ? {
      ...prev,
      [target]: { ...prev[target], approved: true }
    } : prev);
  }

  function rejectDraft(target: string) {
    setBulkDrafts(prev => prev[target] ? {
      ...prev,
      [target]: { ...prev[target], approved: false }
    } : prev);
  }

  function approveAllDrafts() {
    setBulkDrafts(prev => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (next[k].status === "done") {
          next[k] = { ...next[k], approved: true };
        }
      }
      return next;
    });
  }

  function rejectAllDrafts() {
    setBulkDrafts(prev => {
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (next[k].status === "done") {
          next[k] = { ...next[k], approved: false };
        }
      }
      return next;
    });
  }

  return {
    draftingTarget, setDraftingTarget,
    draftedContent, setDraftedContent,
    selectedUnresolvedTargets, setSelectedUnresolvedTargets,
    bulkDrafts, setBulkDrafts,
    isBulkProcessing,
    runUnresolvedLinksScan,
    draftStubNote,
    runBulkDrafting,
    createSelectedStubs,
    handleSelectAllToggle,
    approveDraft,
    rejectDraft,
    approveAllDrafts,
    rejectAllDrafts,
  };
}
