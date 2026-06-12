interface UrlPdfInputsProps {
  url: string;
  onUrlChange: (v: string) => void;
  onUrlFetch: () => void;
  onPdfSelect: () => void;
  busy: boolean;
  statusLabel: string | undefined;
}

export function UrlPdfInputs({ url, onUrlChange, onUrlFetch, onPdfSelect, busy, statusLabel }: UrlPdfInputsProps) {
  return (
    <>
      <div className="ingestSection">
        <label style={{ fontSize: "0.85rem", color: "var(--text-muted, #888)" }}>
          웹 페이지 URL
        </label>
        <div style={{ display: "flex", gap: "6px" }}>
          <input
            type="url"
            className="ingestUrlInput"
            placeholder="https://example.com/article"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && onUrlFetch()}
            disabled={busy}
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={onUrlFetch} disabled={busy || !url.trim()}>
            Fetch
          </button>
        </div>
      </div>

      <div className="ingestDivider">또는</div>

      <div className="ingestSection">
        <label style={{ fontSize: "0.85rem", color: "var(--text-muted, #888)" }}>
          PDF 문서
        </label>
        <button onClick={onPdfSelect} disabled={busy} style={{ alignSelf: "flex-start" }}>
          PDF 선택…
        </button>
      </div>

      {busy && (
        <div className="ingestProgress" aria-live="polite">
          <span className="ingestSpinner" /> {statusLabel}
        </div>
      )}
    </>
  );
}
