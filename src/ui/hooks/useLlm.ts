import { useState } from "react";
import { vaultApi } from "../../api";
import { sendChatMessage, type ChatMessage } from "../../api/llm";
import type { ContextBundle, LlmConfig, NoteDocument, NoteTemplate, ProposedEdit, VaultConfig, VaultSnapshot } from "../../api/types";
import { DEFAULT_LLM_CONFIG } from "./contextShared";

export interface MetadataSuggestions {
  tags: string[];
  frontmatter: Record<string, string>;
}

export interface UseLlmCallbacks {
  activePath: string | null;
  vault: VaultSnapshot | null;
  setVault: React.Dispatch<React.SetStateAction<VaultSnapshot | null>>;
  document: NoteDocument | null;
  draft: string;
  setDraft: (d: string) => void;
  contextBundle: ContextBundle | null;
  promptInstruction: string;
  includeContext: boolean;
  allTags: string[];
  vaultConfig: VaultConfig;
  defaultNoteTemplates: NoteTemplate[];
  setStatus: (status: string) => void;
  selectNote: (path: string) => Promise<void>;
  runHealthAudit: () => Promise<void>;
}

export function useLlm(callbacks: UseLlmCallbacks) {
  const {
    activePath,
    vault,
    setVault,
    document,
    draft,
    setDraft,
    contextBundle,
    promptInstruction,
    includeContext,
    allTags,
    vaultConfig,
    defaultNoteTemplates,
    setStatus,
    selectNote,
    runHealthAudit,
  } = callbacks;

  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_LLM_CONFIG);
  const [showLlmSettings, setShowLlmSettings] = useState(false);
  const [isLlmGenerating, setIsLlmGenerating] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [distillInputText, setDistillInputText] = useState("");
  const [proposedEdits, setProposedEdits] = useState<ProposedEdit[]>([]);

  const [metadataSuggestions, setMetadataSuggestions] = useState<MetadataSuggestions | null>(null);
  const [selectedSuggestedTags, setSelectedSuggestedTags] = useState<Set<string>>(new Set());
  const [selectedSuggestedProperties, setSelectedSuggestedProperties] = useState<Set<string>>(new Set());
  const [isGeneratingMetadata, setIsGeneratingMetadata] = useState(false);
  const [isAutofillingTemplate, setIsAutofillingTemplate] = useState(false);

  async function handleSendChatMessage() {
    if (!chatInput.trim() || isLlmGenerating) {
      return;
    }

    const userText = chatInput.trim();
    setChatInput("");
    setIsLlmGenerating(true);

    const newMessages: ChatMessage[] = [...chatMessages, { role: "user", content: userText }];
    setChatMessages(newMessages);

    try {
      const payload: ChatMessage[] = [];
      let systemContent = "You are an expert wiki copilot. Use the local wiki context to answer user questions or propose wiki edits.";

      if (includeContext && contextBundle) {
        systemContent += `\n\nHere is the active context bundle:\n\n${contextBundle.markdown}`;
      }

      if (promptInstruction && promptInstruction.trim()) {
        systemContent += `\n\nCustom Instructions:\n${promptInstruction.trim()}`;
      }

      systemContent += `\n\nIf you want to suggest modifications to notes, format your edits inside the response using this tag pattern:
<propose_edit type="create|update|merge|delete" path="relative/path/to/note.md" new_path="optional/new/path.md">
<reason>Explain why this edit is suggested.</reason>
<content><![CDATA[New content for create, or target replacement content details]]></content>
<target_content><![CDATA[Exact text to replace in update/merge]]></target_content>
<replacement_content><![CDATA[New replacement text in update/merge]]></replacement_content>
</propose_edit>
You can suggest multiple edits. Do not include markdown wraps around the tags.`;

      payload.push({ role: "system", content: systemContent });
      payload.push(...newMessages);

      const response = await sendChatMessage(llmConfig, payload);

      const updatedMessages: ChatMessage[] = [...newMessages, { role: "assistant" as const, content: response }];
      setChatMessages(updatedMessages);

      const edits = await vaultApi.parseProposedEdits(response);
      if (edits.length > 0) {
        setProposedEdits((prev) => {
          const filteredPrev = prev.filter(p => !edits.some(e => e.path === p.path && e.type === p.type));
          const checkedEdits = edits.map(e => ({ ...e, checked: true }));
          return [...filteredPrev, ...checkedEdits];
        });
        setStatus(`LLM proposed ${edits.length} wiki edit(s)`);
      }
    } catch (error) {
      console.error(error);
      const errMsg = error instanceof Error ? error.message : String(error);
      setChatMessages((prev) => [...prev, { role: "assistant" as const, content: `Error: ${errMsg}` }]);
      setStatus("LLM chat request failed");
    } finally {
      setIsLlmGenerating(false);
    }
  }

  function clearChatHistory() {
    setChatMessages([]);
  }

  async function generateMetadataSuggestions() {
    if (!activePath || !document) return;
    const config = llmConfig;
    if (!config.provider || (!config.apiKey && config.provider !== "ollama" && config.provider !== "lm-studio")) {
      setStatus("Please configure LLM settings first");
      return;
    }

    setIsGeneratingMetadata(true);
    setStatus("Generating metadata suggestions...");
    try {
      const prompt = `Analyze this note and suggest metadata (tags and YAML frontmatter key-value pairs).
Return the result STRICTLY as a JSON object with this structure:
{
  "tags": ["tag1", "tag2"],
  "frontmatter": {
    "status": "draft",
    "area": "product",
    "summary": "Brief summary..."
  }
}
Do not return any other text, markdown formatting, or explanation. Only return the raw JSON object.

Existing tags in the vault: ${allTags.join(", ")} (prefer using existing tags if they fit, but suggest new ones if appropriate)

Note title: ${document.path.replace(/\.md$/i, "")}
Note content:
${draft}
`;

      const response = await sendChatMessage(config, [
        { role: "system", content: "You are a metadata assistant. You only respond with JSON." },
        { role: "user", content: prompt }
      ]);

      const cleanResponse = response.replace(/```json/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleanResponse);

      const tags = Array.isArray(parsed.tags) ? parsed.tags.map((t: any) => String(t).replace(/^#/, "").trim()) : [];
      const frontmatter: Record<string, string> = {};
      if (parsed.frontmatter && typeof parsed.frontmatter === "object") {
        for (const [k, v] of Object.entries(parsed.frontmatter)) {
          frontmatter[k] = String(v);
        }
      }

      setMetadataSuggestions({ tags, frontmatter });
      setSelectedSuggestedTags(new Set(tags));
      setSelectedSuggestedProperties(new Set(Object.keys(frontmatter)));
      setStatus("Generated suggestions!");
    } catch (e) {
      console.error("Failed to generate metadata suggestions", e);
      setStatus(`Failed to generate suggestions: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsGeneratingMetadata(false);
    }
  }

  function handleToggleSuggestedTag(tag: string) {
    setSelectedSuggestedTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }

  function handleToggleSuggestedProperty(key: string) {
    setSelectedSuggestedProperties(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  async function applyMetadataSuggestions() {
    if (!activePath || !document || !metadataSuggestions) return;
    setStatus("Applying metadata...");
    try {
      const tagsToApply = Array.from(selectedSuggestedTags);
      const propertiesToApply: Record<string, string> = {};
      for (const key of Array.from(selectedSuggestedProperties)) {
        propertiesToApply[key] = metadataSuggestions.frontmatter[key];
      }

      await vaultApi.applyNoteMetadata(activePath, propertiesToApply, tagsToApply);

      setStatus("Applied metadata successfully!");
      setMetadataSuggestions(null);

      if (vault) {
        const nextVault = await vaultApi.openVault(vault.rootPath);
        setVault(nextVault);
      }
      await selectNote(activePath);
      void runHealthAudit();
    } catch (e) {
      console.error("Failed to apply metadata suggestions", e);
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function autofillActiveNoteWithTemplate(templateName: string) {
    if (!activePath || !document) return;
    const config = llmConfig;
    if (!config.provider || (!config.apiKey && config.provider !== "ollama" && config.provider !== "lm-studio")) {
      setStatus("Please configure LLM settings first");
      return;
    }

    const template = (vaultConfig.noteTemplates || defaultNoteTemplates).find(t => t.name === templateName);
    if (!template) return;

    setIsAutofillingTemplate(true);
    setStatus(`Applying template "${templateName}" with LLM...`);
    try {
      const prompt = `You are a note template assistant.
Generate note content for a note titled "${document.path.replace(/\.md$/i, "")}" based on the following template instructions:
Template Name: ${template.name}
Template Guidelines: ${template.prompt}

Current note content (if any, use it as context to preserve existing information or draft a new note from scratch if empty):
${draft}

Return the complete note content including any YAML frontmatter block at the very top (bounded by ---). Return ONLY the raw markdown content. Do not include markdown code block formatting (like \`\`\`markdown) around your response.`;

      const response = await sendChatMessage(config, [
        { role: "system", content: "You only output raw markdown note content. Do not explain." },
        { role: "user", content: prompt }
      ]);

      const cleanResponse = response.replace(/^```markdown\n?/i, "").replace(/```$/g, "").trim();
      setDraft(cleanResponse);
      setStatus(`Applied template "${templateName}"!`);
    } catch (e) {
      console.error("Failed to apply template", e);
      setStatus(`Failed to apply template: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsAutofillingTemplate(false);
    }
  }

  return {
    llmConfig, setLlmConfig,
    showLlmSettings, setShowLlmSettings,
    isLlmGenerating, setIsLlmGenerating,
    chatMessages, setChatMessages,
    chatInput, setChatInput,
    distillInputText, setDistillInputText,
    proposedEdits, setProposedEdits,
    metadataSuggestions, setMetadataSuggestions,
    selectedSuggestedTags,
    selectedSuggestedProperties,
    isGeneratingMetadata,
    isAutofillingTemplate,
    handleSendChatMessage,
    clearChatHistory,
    generateMetadataSuggestions,
    handleToggleSuggestedTag,
    handleToggleSuggestedProperty,
    applyMetadataSuggestions,
    autofillActiveNoteWithTemplate,
  };
}
