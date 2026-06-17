import type { AiProvenance } from "./ingestReviewTypes";

export type PromptRun = {
  id: string;
  question: string;
  selectedNotes: string[];
  preset: string;
  purpose: string;
  mode: "short" | "standard" | "full";
  tokenCount: number;
  createdAt: string;
  activePath: string;
  promptHash?: string;
  preview?: string;
};

export type PromptTemplate = {
  id: string;
  name: string;
  template: string;
  isSystem?: boolean;
};

export type LlmProvider = "openai" | "anthropic" | "gemini" | "ollama" | "custom" | "lm-studio";

export type LlmConfig = {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  embeddingModel?: string;
  embeddingProvider?: "openai" | "ollama" | "custom" | "local-onnx";
};

export type NoteTemplate = {
  name: string;
  description: string;
  prompt: string;
};

export type VaultConfig = {
  version?: number;
  contextLimit?: number;
  bundlePreset?: string;
  bundlePurpose?: string;
  bundleMode?: "short" | "standard" | "full";
  selectedPaths?: Record<string, string[]>;
  promptInstructions?: Record<string, string>;
  promptRuns?: PromptRun[];
  promptTemplates?: PromptTemplate[];
  llmConfig?: LlmConfig;
  archiveRetentionPolicy?: string;
  noteTemplates?: NoteTemplate[];
  maintenanceSuggestions?: Record<string, { proposed: string; provenance: AiProvenance; generatedAt: string }>;
};
