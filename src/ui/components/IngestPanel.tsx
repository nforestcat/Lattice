import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { ingestPdf, ingestUrl } from "../../api/tauriVault";
import { ingestToNote } from "../../core/ingest";
import type { EntryMutationResult, LlmConfig, VaultConfig } from "../../api/types";
import { vaultApi } from "../../api";

interface IngestPanelProps {
  open: boolean;
  onClose: () => void;
  llmConfig: LlmConfig;
  vaultConfig: VaultConfig;
  onIngested: (path: string) => void;
  setVault: (vault: EntryMutationResult["vault"]) => void;
}

type IngestStatus = "idle" | "fetching" | "processing" | "saving" | "done" | "error";

export function IngestPanel({
  open,
  onClose,
  llmConfig,
  vaultConfig,
  onIngested,
  setVault,
}: IngestPanelProps) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<IngestStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastCreatedPath, setLastCreatedPath] = useState<string | null>(null);

  if (!open) return null;

  async function runIngest(getRaw: () => Promise<import("../../api/types").IngestRaw>) {
    setError(null);
    setStatus("fetching");
    try {
      const raw = await getRaw();
      setStatus("processing");
      const result = await ingestToNote(raw, llmConfig, vaultConfig.contextLimit);
      setStatus("saving");
      const createResult = await vaultApi.createNote("Ingested", result.title);
      setVault(createResult.vault);
      await vaultApi.saveNote(createResult.selectedPath!, result.markdown, "");
      setLastCreatedPath(createResult.selectedPath);
      setStatus("done");
      if (createResult.selectedPath) onIngested(createResult.selectedPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  async function handleUrlIngest() {
    if (!url.trim()) return;
    await runIngest(() => ingestUrl(url.trim()));
  }

  async function handlePdfIngest() {
    const selected = await openFileDialog({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      multiple: false,
    });
    if (!selected || typeof selected !== "string") return;
    await runIngest(() => ingestPdf(selected));
  }

  function reset() {
    setUrl("");
    setStatus("idle");
    setError(null);
    setLastCreatedPath(null);
  }

  const busy = status === "fetching" || status === "processing" || status === "saving";

  const statusLabel: Partial<Record<IngestStatus, string>> = {
    fetching: "Fetching content…",
    processing: "Processing with Ollama…",
    saving: "Saving note…",
  };

  return (
    <div
      className="ingestPanelOverlay"
      role="dialog"
      aria-modal="true"
      aria-label="Ingest external content"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="ingestPanel">
        <div className="ingestPanelHeader">
          <h2 style={{ margin: 0, fontSize: "1rem" }}>Ingest</h2>
          <button
            className="ingestCloseBtn"
            onClick={onClose}
            aria-label="Close"
            disabled={busy}
          >
            ✕
          </button>
        </div>

        {status === "done" ? (
          <div className="ingestSuccess">
            <p>✓ Note saved{lastCreatedPath ? `: ${lastCreatedPath}` : ""}</p>
            <div style={{ display: "flex", gap: "8px" }}>
              <button className="primary" onClick={reset}>
                Ingest another
              </button>
              <button onClick={onClose}>Close</button>
            </div>
          </div>
        ) : (
          <>
            <div className="ingestSection">
              <label style={{ fontSize: "0.85rem", color: "var(--text-muted, #888)" }}>
                Web page URL
              </label>
              <div style={{ display: "flex", gap: "6px" }}>
                <input
                  type="url"
                  className="ingestUrlInput"
                  placeholder="https://example.com/article"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !busy && void handleUrlIngest()}
                  disabled={busy}
                  style={{ flex: 1 }}
                />
                <button
                  className="primary"
                  onClick={() => void handleUrlIngest()}
                  disabled={busy || !url.trim()}
                >
                  Fetch
                </button>
              </div>
            </div>

            <div className="ingestDivider">or</div>

            <div className="ingestSection">
              <label style={{ fontSize: "0.85rem", color: "var(--text-muted, #888)" }}>
                PDF document
              </label>
              <button
                onClick={() => void handlePdfIngest()}
                disabled={busy}
                style={{ alignSelf: "flex-start" }}
              >
                Choose PDF…
              </button>
            </div>

            {busy && (
              <div className="ingestProgress" aria-live="polite">
                <span className="ingestSpinner" /> {statusLabel[status]}
              </div>
            )}

            {status === "error" && error && (
              <div className="ingestError" role="alert">
                {error}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
