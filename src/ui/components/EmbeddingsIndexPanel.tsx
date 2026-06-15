import { useEffect, useState } from "react";
import { useEmbeddingsIndex } from "../hooks/useEmbeddingsIndex";
import type { LlmConfig, VaultSnapshot } from "../../api/types";
import { invoke } from "@tauri-apps/api/core";

type ModelStatus = {
  downloaded: boolean;
  downloading: boolean;
  progressPct: number | null;
  modelSizeMb: number;
};

type Props = {
  llmConfig: LlmConfig | null;
  vault: VaultSnapshot | null;
};

export function EmbeddingsIndexPanel({ llmConfig, vault }: Props) {
  const { indexedCount, staleCount, failedNotes, isReindexing, lastRefreshed, refresh, reindex } =
    useEmbeddingsIndex(llmConfig, vault);

  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    invoke<ModelStatus>("get_local_embedding_model_status")
      .then(setModelStatus)
      .catch(() => setModelStatus(null));
  }, []);

  async function handleDownloadModel() {
    setIsDownloading(true);
    try {
      await invoke("download_local_embedding_model");
      const status = await invoke<ModelStatus>("get_local_embedding_model_status");
      setModelStatus(status);
    } catch (err) {
      console.error("Model download failed:", err);
    } finally {
      setIsDownloading(false);
    }
  }

  const totalNotes = vault?.notes.length ?? 0;

  return (
    <div className="embeddingsIndexPanel" style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "12px" }}>
      <div>
        <strong>Embeddings Index</strong>
        {lastRefreshed && (
          <span style={{ fontSize: "0.75em", opacity: 0.6, marginLeft: 8 }}>
            refreshed {lastRefreshed.toLocaleTimeString()}
          </span>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px", textAlign: "center" }}>
        <div>
          <div style={{ fontSize: "1.4em", fontWeight: "bold" }}>{indexedCount}</div>
          <div style={{ fontSize: "0.75em", opacity: 0.7 }}>indexed</div>
        </div>
        <div>
          <div style={{ fontSize: "1.4em", fontWeight: "bold" }}>{staleCount}</div>
          <div style={{ fontSize: "0.75em", opacity: 0.7 }}>stale</div>
        </div>
        <div>
          <div style={{ fontSize: "1.4em", fontWeight: "bold" }}>{totalNotes}</div>
          <div style={{ fontSize: "0.75em", opacity: 0.7 }}>total</div>
        </div>
      </div>

      <button
        type="button"
        disabled={isReindexing || !llmConfig}
        onClick={reindex}
        style={{ padding: "6px 12px" }}
      >
        {isReindexing ? "Reindexing…" : "Reindex stale & failed"}
      </button>

      {failedNotes.length > 0 && (
        <div>
          <div style={{ fontSize: "0.8em", fontWeight: "bold", marginBottom: 4 }}>
            Failed notes ({failedNotes.length})
          </div>
          <ul style={{ margin: 0, padding: "0 0 0 16px", fontSize: "0.75em", display: "flex", flexDirection: "column", gap: 4 }}>
            {failedNotes.map((n) => (
              <li key={n.path} title={n.lastError}>
                <span style={{ wordBreak: "break-all" }}>{n.path}</span>
                <br />
                <span style={{ opacity: 0.6 }}>{n.lastError}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <div style={{ fontSize: "0.8em", fontWeight: "bold", marginBottom: 4 }}>Local ONNX model</div>
        {modelStatus === null ? (
          <span style={{ fontSize: "0.75em", opacity: 0.6 }}>unavailable</span>
        ) : modelStatus.downloaded ? (
          <span style={{ fontSize: "0.75em" }}>
            Downloaded ({modelStatus.modelSizeMb.toFixed(1)} MB)
          </span>
        ) : (
          <button
            type="button"
            disabled={isDownloading}
            onClick={handleDownloadModel}
            style={{ fontSize: "0.8em", padding: "4px 8px" }}
          >
            {isDownloading ? "Downloading…" : "Download model"}
          </button>
        )}
      </div>
    </div>
  );
}
