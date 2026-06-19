import type { LlmConfig, LlmProvider, PromptRun, PromptTemplate, VaultConfig } from "../../api/types";

export const DEFAULT_LLM_CONFIG: LlmConfig = { provider: "openai", apiKey: "", model: "gpt-4o" };

export type PresetType = "custom" | "ask" | "refactor" | "summarize" | "plan" | "debug";

export const PRESETS: Record<PresetType, { label: string; purpose: string; mode: "short" | "standard" | "full" }> = {
  custom: {
    label: "Custom Preset",
    purpose: "",
    mode: "standard"
  },
  ask: {
    label: "Ask (Q&A)",
    purpose: "Answer questions based on the provided wiki context.",
    mode: "standard"
  },
  refactor: {
    label: "Refactor",
    purpose: "Review code structure, propose refactorings, or suggest quality improvements.",
    mode: "full"
  },
  summarize: {
    label: "Summarize",
    purpose: "Create a concise summary, key points, and structural takeaways.",
    mode: "short"
  },
  plan: {
    label: "Plan",
    purpose: "Develop an implementation plan, design document, or task breakdown.",
    mode: "standard"
  },
  debug: {
    label: "Debug",
    purpose: "Diagnose errors, trace bugs, or suggest unit tests to fix issues.",
    mode: "full"
  }
};

export const VAULT_CONFIG_VERSION = 1;

export function normalizePreset(value: unknown): PresetType {
  return typeof value === "string" && value in PRESETS ? value as PresetType : "ask";
}

export function normalizeLegacyPreset(value: unknown): PresetType {
  if (value === "review") {
    return "refactor";
  }
  if (value === "write") {
    return "plan";
  }
  return normalizePreset(value);
}

export function normalizeBundleMode(value: unknown, fallback: "short" | "standard" | "full"): "short" | "standard" | "full" {
  return value === "short" || value === "standard" || value === "full" ? value : fallback;
}

export function presetForSettings(purpose: string, mode: "short" | "standard" | "full"): PresetType {
  const matched = Object.entries(PRESETS).find(([key, config]) => {
    return key !== "custom" && config.purpose === purpose && config.mode === mode;
  });
  return matched ? matched[0] as PresetType : "custom";
}

export function buildCombinedPrompt(instruction: string, bundleMarkdown: string): string {
  return instruction.trim()
    ? `${instruction.trim()}\n\n---\n\n${bundleMarkdown}`
    : bundleMarkdown;
}

export function simplePromptHash(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = (Math.imul(31, hash) + content.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16);
}

export function redactLlmConfig<T extends { apiKey: string }>(config: T): T {
  return { ...config, apiKey: "" };
}

export function sanitizeVaultConfig(config: VaultConfig): VaultConfig {
  return {
    ...config,
    llmConfig: config.llmConfig ? redactLlmConfig(config.llmConfig) : config.llmConfig
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === "string" && ["openai", "anthropic", "gemini", "ollama", "custom", "lm-studio"].includes(value);
}

function isEmbeddingProvider(value: unknown): value is NonNullable<LlmConfig["embeddingProvider"]> {
  return typeof value === "string" && ["openai", "ollama", "custom", "local-onnx"].includes(value);
}

function isStringKeyedRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeLlmConfigInternal(value: unknown): LlmConfig | undefined {
  if (!isStringKeyedRecord(value)) {
    return undefined;
  }
  return {
    provider: isLlmProvider(value.provider) ? value.provider : "openai",
    apiKey: "",
    model: typeof value.model === "string" ? value.model : "",
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : undefined,
    embeddingModel: typeof value.embeddingModel === "string" ? value.embeddingModel : undefined,
    embeddingProvider: isEmbeddingProvider(value.embeddingProvider) ? value.embeddingProvider : undefined
  };
}

function normalizeSelectedPaths(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, paths]) => typeof key === "string" && Array.isArray(paths))
      .map(([key, paths]) => [key, normalizeStringArray(paths)])
  );
}

function normalizePromptInstructions(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => {
      return typeof entry[0] === "string" && typeof entry[1] === "string";
    })
  );
}

function normalizePromptRuns(value: unknown, fallbackPurpose: string): PromptRun[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((run): run is Record<string, unknown> => !!run && typeof run === "object" && !Array.isArray(run))
    .map((run, index) => {
      const preset = typeof run.preset === "string" && run.preset ? run.preset : "ask";
      const presetForFallbacks = normalizeLegacyPreset(preset);
      return {
        id: typeof run.id === "string" && run.id ? run.id : `legacy-run-${index + 1}`,
        question: typeof run.question === "string" ? run.question : "",
        selectedNotes: normalizeStringArray(run.selectedNotes),
        preset,
        purpose: typeof run.purpose === "string" ? run.purpose : PRESETS[presetForFallbacks].purpose || fallbackPurpose,
        mode: normalizeBundleMode(run.mode, PRESETS[presetForFallbacks].mode),
        tokenCount: Number.isFinite(run.tokenCount) && Number(run.tokenCount) >= 0 ? Number(run.tokenCount) : 0,
        createdAt: typeof run.createdAt === "string" ? run.createdAt : "",
        activePath: typeof run.activePath === "string" ? run.activePath : "",
        promptHash: typeof run.promptHash === "string" ? run.promptHash : undefined,
        preview: typeof run.preview === "string" ? run.preview : undefined
      };
    });
}

function normalizePromptTemplates(value: unknown): PromptTemplate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((template): template is Record<string, unknown> => !!template && typeof template === "object" && !Array.isArray(template))
    .filter((template) => typeof template.name === "string" && typeof template.template === "string")
    .map((template, index) => ({
      id: typeof template.id === "string" && template.id ? template.id : `template-${index + 1}`,
      name: template.name as string,
      template: template.template as string,
      isSystem: typeof template.isSystem === "boolean" ? template.isSystem : false
    }));
}

export function normalizeVaultConfig(config: unknown): VaultConfig {
  const input = isStringKeyedRecord(config) ? config : {};
  const preset = normalizePreset(input.bundlePreset);
  const bundlePurpose = typeof input.bundlePurpose === "string" ? input.bundlePurpose : PRESETS[preset].purpose;
  const bundleMode = normalizeBundleMode(input.bundleMode, PRESETS[preset].mode);
  const noteTemplates = Array.isArray(input.noteTemplates) ? input.noteTemplates as VaultConfig["noteTemplates"] : undefined;
  const maintenanceSuggestions = isStringKeyedRecord(input.maintenanceSuggestions) ? input.maintenanceSuggestions as VaultConfig["maintenanceSuggestions"] : undefined;
  const normalized: VaultConfig = {
    version: Math.max(VAULT_CONFIG_VERSION, typeof input.version === "number" ? input.version : VAULT_CONFIG_VERSION),
    contextLimit: typeof input.contextLimit === "number" && Number.isFinite(input.contextLimit) && input.contextLimit > 0 ? input.contextLimit : 8000,
    bundlePreset: preset,
    bundlePurpose,
    bundleMode,
    selectedPaths: normalizeSelectedPaths(input.selectedPaths),
    promptInstructions: normalizePromptInstructions(input.promptInstructions),
    promptRuns: normalizePromptRuns(input.promptRuns, bundlePurpose),
    promptTemplates: normalizePromptTemplates(input.promptTemplates),
    llmConfig: normalizeLlmConfigInternal(input.llmConfig),
    archiveRetentionPolicy: typeof input.archiveRetentionPolicy === "string" ? input.archiveRetentionPolicy : "none",
    noteTemplates,
    maintenanceSuggestions
  };
  return normalized;
}
