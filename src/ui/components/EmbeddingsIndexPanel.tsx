import { useEffect, useRef, useState } from "react";
import { useEmbeddingsIndex } from "../hooks/useEmbeddingsIndex";
import { useModelDownloadContext } from "../contexts/ModelDownloadContext";
import type { LlmConfig, VaultSnapshot } from "../../api/types";

type Props = {
  llmConfig: LlmConfig | null;
  vault: VaultSnapshot | null;
  onUpdateLlmConfig?: (patch: Partial<LlmConfig>) => void;
};

type StepState = "todo" | "active" | "done" | "error";

function stepIndicator(state: StepState) {
  const base: React.CSSProperties = {
    width: 22, height: 22, borderRadius: "50%", display: "flex",
    alignItems: "center", justifyContent: "center",
    fontSize: "11px", fontWeight: 700, flexShrink: 0,
  };
  if (state === "done") return <div style={{ ...base, background: "#16a34a", color: "#fff" }}>✓</div>;
  if (state === "active") return <div style={{ ...base, background: "#6366f1", color: "#fff" }}>●</div>;
  if (state === "error") return <div style={{ ...base, background: "#dc2626", color: "#fff" }}>!</div>;
  return <div style={{ ...base, background: "#e2e8f0", color: "#94a3b8" }}>○</div>;
}

export function EmbeddingsIndexPanel({ llmConfig, vault, onUpdateLlmConfig }: Props) {
  const { indexedCount, staleCount, failedNotes, isReindexing, lastRefreshed, refresh, reindex } =
    useEmbeddingsIndex(llmConfig, vault);
  const { downloaded, modelSizeMb, downloading, progress, error: downloadError, startDownload } =
    useModelDownloadContext();

  useEffect(() => { refresh(); }, [refresh]);

  const [showReindexPrompt, setShowReindexPrompt] = useState(false);
  const prevDownloadedRef = useRef(false);

  useEffect(() => {
    if (downloaded && !prevDownloadedRef.current && staleCount > 0) {
      setShowReindexPrompt(true);
    }
    prevDownloadedRef.current = downloaded;
  }, [downloaded, staleCount]);

  useEffect(() => {
    if (isReindexing) setShowReindexPrompt(false);
  }, [isReindexing]);

  const totalNotes = vault?.notes.length ?? 0;
  const isEnabled = llmConfig?.embeddingProvider === "local-onnx";
  const isIndexed = staleCount === 0 && failedNotes.length === 0;
  const isReady = isEnabled && downloaded && isIndexed;

  // Only show stepper for local-onnx or unset (first-run)
  const showStepper = !llmConfig?.embeddingProvider || llmConfig.embeddingProvider === "local-onnx";

  // Derive step states
  const step1State: StepState = isEnabled ? "done" : "active";
  const step2State: StepState = !isEnabled ? "todo" : downloaded ? "done" : downloadError ? "error" : "active";
  const step3State: StepState = !downloaded ? "todo" : isIndexed ? "done" : "active";
  const step4State: StepState = !isIndexed ? "todo" : isReady ? "done" : "active";

  if (!showStepper) {
    // Non-local-onnx provider: just show readiness badges
    return (
      <div style={{ padding: "12px" }}>
        <ReadinessBadges
          downloaded={downloaded}
          staleCount={staleCount}
          failedCount={failedNotes.length}
          embeddingProvider={llmConfig?.embeddingProvider}
        />
      </div>
    );
  }

  return (
    <div className="embeddingsIndexPanel" style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "0" }}>
      <div style={{ marginBottom: "12px" }}>
        <strong>Offline Semantic Search Setup</strong>
        {lastRefreshed && (
          <span style={{ fontSize: "0.75em", opacity: 0.6, marginLeft: 8 }}>
            refreshed {lastRefreshed.toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Step 1 — Enable */}
      <StepRow
        state={step1State}
        title="Enable offline semantic search"
        disabled={false}
      >
        {step1State !== "done" && (
          <div style={{ fontSize: "12px", color: "#475569", marginTop: 6 }}>
            <p style={{ margin: "0 0 8px 0" }}>
              Enable privacy-first semantic search — no API key needed, runs fully offline.
            </p>
            <button
              type="button"
              className="smallButton primary"
              onClick={() => onUpdateLlmConfig?.({ embeddingProvider: "local-onnx" })}
            >
              Enable
            </button>
          </div>
        )}
      </StepRow>

      {/* Step 2 — Download */}
      <StepRow
        state={step2State}
        title={`Download model (~${modelSizeMb.toFixed(0)} MB)`}
        disabled={step1State !== "done"}
      >
        {step2State !== "done" && step1State === "done" && (
          <div style={{ fontSize: "12px", marginTop: 6 }}>
            {downloading ? (
              <div>
                <div style={{ fontSize: "0.85em", marginBottom: 4, color: "#475569" }}>
                  {progress?.pct != null ? `${progress.pct}% — downloading…` : "Downloading…"}
                </div>
                <div style={{ height: 4, background: "#e2e8f0", borderRadius: 2 }}>
                  <div style={{
                    height: "100%", background: "#6366f1", borderRadius: 2,
                    width: progress?.pct != null ? `${progress.pct}%` : "60%",
                    transition: progress?.pct != null ? "width 0.3s" : undefined,
                    animation: progress?.pct == null ? "pulse 1.5s ease-in-out infinite" : undefined,
                  }} />
                </div>
              </div>
            ) : downloadError ? (
              <div>
                <span style={{ color: "#dc2626", fontSize: "0.85em" }}>{downloadError}</span>
                <button type="button" className="smallButton" style={{ marginLeft: 8 }} onClick={() => void startDownload()}>Retry</button>
              </div>
            ) : (
              <button type="button" className="smallButton primary" onClick={() => void startDownload()}>
                Download model
              </button>
            )}
          </div>
        )}
      </StepRow>

      {/* Step 3 — Reindex */}
      <StepRow
        state={step3State}
        title="Index your notes"
        disabled={step2State !== "done"}
      >
        {step2State === "done" && (
          <div style={{ fontSize: "12px", marginTop: 6 }}>
            <div style={{ display: "flex", gap: "16px", marginBottom: 8 }}>
              <span><strong>{indexedCount}</strong> <span style={{ opacity: 0.7 }}>indexed</span></span>
              <span><strong>{staleCount}</strong> <span style={{ opacity: 0.7 }}>stale</span></span>
              <span><strong>{totalNotes}</strong> <span style={{ opacity: 0.7 }}>total</span></span>
            </div>
            {showReindexPrompt && (
              <div style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 6, padding: "8px 10px", marginBottom: 10, fontSize: "12px" }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Index {staleCount} note{staleCount !== 1 ? "s" : ""} now?</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="smallButton primary"
                    disabled={isReindexing || !llmConfig}
                    onClick={() => { setShowReindexPrompt(false); reindex(); }}
                  >
                    Run
                  </button>
                  <button
                    type="button"
                    className="smallButton"
                    onClick={() => setShowReindexPrompt(false)}
                  >
                    Later
                  </button>
                </div>
              </div>
            )}
            {(staleCount > 0 || failedNotes.length > 0) && (
              <button
                type="button"
                className="smallButton primary"
                disabled={isReindexing || !llmConfig}
                onClick={reindex}
              >
                {isReindexing ? "Reindexing…" : "Reindex stale & failed"}
              </button>
            )}
            {failedNotes.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Failed ({failedNotes.length})</div>
                <ul style={{ margin: 0, padding: "0 0 0 14px", display: "flex", flexDirection: "column", gap: 2 }}>
                  {failedNotes.map(n => (
                    <li key={n.path} title={n.lastError}>
                      <span style={{ wordBreak: "break-all" }}>{n.path}</span>
                      {n.lastError && <span style={{ opacity: 0.6, display: "block" }}>{n.lastError}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </StepRow>

      {/* Step 4 — Activate */}
      <StepRow
        state={step4State}
        title="Activate"
        disabled={step3State !== "done"}
        last
      >
        {step3State === "done" && (
          <div style={{ marginTop: 8 }}>
            <ReadinessBadges
              downloaded={downloaded}
              staleCount={staleCount}
              failedCount={failedNotes.length}
              embeddingProvider={llmConfig?.embeddingProvider}
            />
          </div>
        )}
      </StepRow>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────

interface StepRowProps {
  state: StepState;
  title: string;
  disabled: boolean;
  last?: boolean;
  children?: React.ReactNode;
}

function StepRow({ state, title, disabled, last, children }: StepRowProps) {
  const dimmed = disabled || state === "todo";
  return (
    <div style={{ display: "flex", gap: "10px", paddingBottom: last ? 0 : "12px", opacity: dimmed ? 0.45 : 1 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        {stepIndicator(state)}
        {!last && <div style={{ flex: 1, width: 2, background: "#e2e8f0", minHeight: 12, marginTop: 4 }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : "8px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, color: state === "done" ? "#16a34a" : state === "error" ? "#dc2626" : "#1e293b" }}>
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

// US-004 Readiness badges
interface ReadinessBadgesProps {
  downloaded: boolean;
  staleCount: number;
  failedCount: number;
  embeddingProvider?: string;
}

type BadgeStatus = "ready" | "degraded" | "disabled";

function ReadinessBadges({ downloaded, staleCount, failedCount, embeddingProvider }: ReadinessBadgesProps) {
  const isLocalOnnx = embeddingProvider === "local-onnx";
  const isIndexed = staleCount === 0 && failedCount === 0;

  function getStatus(): { status: BadgeStatus; reason: string } {
    if (!isLocalOnnx || !downloaded) {
      return {
        status: "disabled",
        reason: !isLocalOnnx ? "Enable offline embedding in Step 1" : "Download model in Step 2",
      };
    }
    if (!isIndexed) {
      return { status: "degraded", reason: `${staleCount + failedCount} note(s) not yet indexed` };
    }
    return { status: "ready", reason: "" };
  }

  const { status, reason } = getStatus();

  const badgeStyle = (s: BadgeStatus): React.CSSProperties => ({
    display: "inline-block",
    fontSize: "10px",
    fontWeight: 700,
    padding: "2px 6px",
    borderRadius: 3,
    background: s === "ready" ? "#dcfce7" : s === "degraded" ? "#fef9c3" : "#f1f5f9",
    color: s === "ready" ? "#16a34a" : s === "degraded" ? "#854d0e" : "#64748b",
  });

  const features = ["Semantic search", "Graph similarity", "Link suggestions"];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {features.map(f => (
        <div key={f} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px" }}>
          <span style={{ color: "#475569" }}>{f}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={badgeStyle(status)}>
              {status === "ready" ? "Ready" : status === "degraded" ? "Degraded" : "Disabled"}
            </span>
            {reason && <span style={{ fontSize: "10px", color: "#94a3b8" }}>{reason}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
