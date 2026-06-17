import { useState } from "react";
import type { LlmConfig, LlmProvider, VaultConfig } from "../../api/types";
import { vaultApi } from "../../api";
import { useModelDownloadContext } from "../contexts/ModelDownloadContext";

function LocalOnnxModelStatus() {
  const { downloaded, modelSizeMb, downloading, progress, error, startDownload } = useModelDownloadContext();

  if (downloaded) {
    return (
      <span style={{ fontSize: "11px", color: "#16a34a", fontWeight: 600 }}>
        ✓ 사용 가능
      </span>
    );
  }

  if (downloading) {
    return (
      <span style={{ fontSize: "11px", color: "#6b7280" }}>
        <span style={{ display: "inline-block", marginRight: "6px" }}>⏳</span>
        다운로드 중{progress?.pct != null ? ` (${progress.pct}%)` : "..."}
      </span>
    );
  }

  if (error) {
    return (
      <span style={{ fontSize: "11px", color: "#dc2626" }}>
        오류: {error}{" "}
        <button type="button" onClick={() => void startDownload()} style={{ fontSize: "11px", cursor: "pointer" }}>재시도</button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void startDownload()}
      style={{
        background: "none",
        border: "1px solid #3b82f6",
        color: "#3b82f6",
        fontSize: "11px",
        fontWeight: 600,
        cursor: "pointer",
        padding: "3px 8px",
        borderRadius: "4px",
      }}
    >
      다운로드 (약 {modelSizeMb.toFixed(0)}MB)
    </button>
  );
}

interface LlmSettingsPanelProps {
  llmConfig: LlmConfig;
  setLlmConfig: React.Dispatch<React.SetStateAction<LlmConfig>>;
  vaultConfig: VaultConfig;
  updateVaultConfig: (updates: Partial<VaultConfig>) => Promise<void>;
  saveStoredLlmApiKey: (provider: LlmProvider, apiKey: string) => void;
  readStoredLlmApiKey: (provider: LlmProvider) => string;
  redactLlmConfig: (config: LlmConfig) => LlmConfig;
  pruneExpiredPromptRuns: (policy: string) => Promise<void>;
  setShowLlmSettings: (show: boolean) => void;
  setStatus: (status: string) => void;
}

export function LlmSettingsPanel({
  llmConfig,
  setLlmConfig,
  vaultConfig,
  updateVaultConfig,
  saveStoredLlmApiKey,
  readStoredLlmApiKey,
  redactLlmConfig,
  pruneExpiredPromptRuns,
  setShowLlmSettings,
  setStatus,
}: LlmSettingsPanelProps) {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);

  const getModelPlaceholder = (provider: LlmProvider) => {
    switch (provider) {
      case "openai": return "e.g. gpt-4o, gpt-4-turbo";
      case "anthropic": return "e.g. claude-3-5-sonnet-latest";
      case "gemini": return "e.g. gemini-1.5-pro, gemini-1.5-flash";
      case "ollama": return "e.g. llama3, mistral, phi3";
      case "lm-studio": return "e.g. qwen2.5-coder-7b";
      default: return "e.g. gpt-4o, llama3";
    }
  };

  async function fetchModels() {
    setIsFetchingModels(true);
    setStatus(`Fetching models for ${llmConfig.provider}...`);
    try {
      const models = await vaultApi.fetchProviderModels(llmConfig.provider, llmConfig.baseUrl);
      setAvailableModels(models);
      if (models.length > 0) {
        setStatus(`Successfully fetched ${models.length} models for ${llmConfig.provider}!`);
      } else {
        setStatus(`No models returned for ${llmConfig.provider}.`);
      }
    } catch (e) {
      console.error("Failed to fetch models", e);
      setStatus(`Failed to fetch models: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIsFetchingModels(false);
    }
  }

  return (
    <div className="llmSettingsPanel">
      <h4>LLM Configuration</h4>
      <div className="formGroup">
        <label>Provider</label>
        <select
          value={llmConfig.provider}
          onChange={(e) => {
            const prov = e.target.value as LlmProvider;
            const defaultBases: Record<LlmProvider, string> = {
              openai: "",
              anthropic: "",
              gemini: "",
              ollama: "http://localhost:11434",
              custom: "http://localhost:1234/v1",
              "lm-studio": "http://localhost:1234/v1"
            };
            setLlmConfig(prev => ({
              ...prev,
              provider: prov,
              apiKey: readStoredLlmApiKey(prov),
              model: prev.model,
              baseUrl: defaultBases[prov] || undefined
            }));
            setAvailableModels([]);
          }}
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="gemini">Google Gemini</option>
          <option value="ollama">Ollama (Local)</option>
          <option value="lm-studio">LM Studio (Local)</option>
          <option value="custom">Custom (OpenAI-compatible)</option>
        </select>
      </div>

      <div className="formGroup">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
          <label style={{ margin: 0 }}>Model</label>
          <button
            type="button"
            className="fetch-models-btn"
            onClick={() => void fetchModels()}
            disabled={isFetchingModels}
            style={{
              background: "none",
              border: "none",
              color: "#3b82f6",
              fontSize: "10px",
              fontWeight: 600,
              cursor: "pointer",
              padding: "2px 4px",
              borderRadius: "4px",
              transition: "background-color 0.2s"
            }}
          >
            {isFetchingModels ? "Fetching..." : "Fetch Models"}
          </button>
        </div>
        <input
          type="text"
          value={llmConfig.model}
          onChange={(e) => setLlmConfig(prev => ({ ...prev, model: e.target.value }))}
          placeholder={getModelPlaceholder(llmConfig.provider)}
          list="available-models-list"
        />
        <datalist id="available-models-list">
          {availableModels.map(m => <option key={m} value={m} />)}
        </datalist>
      </div>

      {llmConfig.provider !== "ollama" && llmConfig.provider !== "lm-studio" && (
        <div className="formGroup">
          <label>API Key</label>
          <input
            type="password"
            value={llmConfig.apiKey}
            onChange={(e) => setLlmConfig(prev => ({ ...prev, apiKey: e.target.value }))}
            placeholder="Enter API Key"
          />
        </div>
      )}

      {(llmConfig.provider === "ollama" || llmConfig.provider === "custom" || llmConfig.provider === "lm-studio") && (
        <div className="formGroup">
          <label>Base URL</label>
          <input
            type="text"
            value={llmConfig.baseUrl || ""}
            onChange={(e) => setLlmConfig(prev => ({ ...prev, baseUrl: e.target.value }))}
            placeholder={llmConfig.provider === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1"}
          />
        </div>
      )}

      {(llmConfig.provider === "ollama" || llmConfig.provider === "openai" || llmConfig.provider === "custom" || llmConfig.provider === "lm-studio") && (
        <div className="formGroup">
          <label>Embedding Provider</label>
          <select
            value={llmConfig.embeddingProvider || ""}
            onChange={(e) => {
              const val = e.target.value as LlmConfig["embeddingProvider"];
              setLlmConfig(prev => ({ ...prev, embeddingProvider: val || undefined }));
            }}
          >
            <option value="">provider와 동일 (기본)</option>
            <option value="local-onnx">Local (ONNX) — 오프라인</option>
            <option value="openai">OpenAI</option>
            <option value="ollama">Ollama</option>
          </select>
        </div>
      )}

      {llmConfig.embeddingProvider === "local-onnx" && (
        <div className="formGroup onnx-model-status">
          <label>ONNX 모델 상태</label>
          <LocalOnnxModelStatus />
        </div>
      )}

      {(llmConfig.provider === "ollama" || llmConfig.provider === "openai" || llmConfig.provider === "custom" || llmConfig.provider === "lm-studio") && llmConfig.embeddingProvider !== "local-onnx" && (
        <div className="formGroup">
          <label>Embedding Model</label>
          <input
            type="text"
            value={llmConfig.embeddingModel || ""}
            onChange={(e) => setLlmConfig(prev => ({ ...prev, embeddingModel: e.target.value }))}
            placeholder={llmConfig.provider === "ollama" ? "all-minilm" : "text-embedding-3-small"}
          />
        </div>
      )}

      <div className="settingsSection" style={{ marginTop: "12px", borderTop: "1px dashed #cbd5e1", paddingTop: "12px", marginBottom: "12px" }}>
        <h4 style={{ margin: "0 0 8px 0", fontSize: "12px", color: "#344054" }}>Prompt Archive Settings</h4>
        <div className="formGroup">
          <label>Auto-Pruning Policy</label>
          <select
            value={vaultConfig.archiveRetentionPolicy || "none"}
            onChange={(e) => {
              const val = e.target.value;
              void updateVaultConfig({
                archiveRetentionPolicy: val
              });
            }}
          >
            <option value="none">Keep all history indefinitely</option>
            <option value="7">Prune runs older than 7 days</option>
            <option value="30">Prune runs older than 30 days</option>
            <option value="90">Prune runs older than 90 days</option>
          </select>
        </div>
        <button
          type="button"
          className="btnPruneExpired"
          style={{ width: "100%", marginTop: "6px", fontSize: "11px", padding: "4px 8px" }}
          onClick={() => void pruneExpiredPromptRuns(vaultConfig.archiveRetentionPolicy || "none")}
        >
          Prune Expired Runs Now
        </button>
      </div>

      <button
        type="button"
        className="primary btnSaveSettings"
        onClick={() => {
          saveStoredLlmApiKey(llmConfig.provider, llmConfig.apiKey);
          void updateVaultConfig({ llmConfig: redactLlmConfig(llmConfig) });
          setShowLlmSettings(false);
          setStatus("LLM settings saved; API key kept in local app storage");
        }}
      >
        Save Settings
      </button>
    </div>
  );
}
