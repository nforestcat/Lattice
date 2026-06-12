import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { type CSSProperties, useState } from "react";
import { ingestPdf, ingestUrl } from "../../api/tauriVault";
import { ingestToNote } from "../../core/ingest";
import { applyTagsToMarkdown } from "../../core/ingestMarkdown";
import type { EntryMutationResult, IngestRaw, LlmConfig, VaultConfig } from "../../api/types";
import { vaultApi } from "../../api";

interface IngestPanelProps {
  open: boolean;
  onClose: () => void;
  llmConfig: LlmConfig;
  vaultConfig: VaultConfig;
  onIngested: (path: string) => void | Promise<void>;
  setVault: (vault: EntryMutationResult["vault"]) => void;
}

type IngestStatus =
  | "idle"
  | "fetching"
  | "preview"
  | "processing"
  | "review"
  | "saving"
  | "done"
  | "error";

function mapErrorMessage(err: string): string {
  if (err.includes("Could not fetch URL (status 4"))
    return "페이지를 찾을 수 없습니다. URL을 확인해 주세요.";
  if (err.includes("Could not fetch URL (status 5"))
    return "서버 오류로 가져올 수 없습니다. 잠시 후 다시 시도해 주세요.";
  if (err.includes("URL is not an HTML page"))
    return "이 URL은 HTML 페이지가 아닙니다 (예: PDF, 이미지). PDF로 가져오기를 사용해 주세요.";
  if (err.includes("No readable content found"))
    return "페이지에서 읽을 수 있는 내용을 찾지 못했습니다.";
  if (err.includes("Extraction too thin"))
    return "추출된 내용이 너무 짧습니다. 브라우저에서 직접 열어야 하는 페이지일 수 있습니다.";
  if (err.includes("No extractable text"))
    return "텍스트를 추출할 수 없습니다. 스캔된 이미지 PDF일 수 있습니다.";
  if (err.toLowerCase().includes("ollama did not respond"))
    return "Ollama가 응답하지 않습니다. 실행 중인지 확인해 주세요.";
  return err;
}

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
  const [titleError, setTitleError] = useState<string | null>(null);
  const [lastCreatedPath, setLastCreatedPath] = useState<string | null>(null);
  const [rawPreview, setRawPreview] = useState<IngestRaw | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [draftMarkdown, setDraftMarkdown] = useState("");
  const [duplicateCheck, setDuplicateCheck] = useState<{
    exactMatch: string | null;
    similarNotes: { path: string; title: string }[];
  } | null>(null);
  const [duplicateDismissed, setDuplicateDismissed] = useState(false);

  if (!open) return null;

  async function fetchRaw(getRaw: () => Promise<IngestRaw>) {
    setError(null);
    setDuplicateCheck(null);
    setDuplicateDismissed(false);
    setStatus("fetching");
    try {
      const raw = await getRaw();
      setRawPreview(raw);

      try {
        const dup = await invoke<{ exactMatch: string | null; similarNotes: { path: string; title: string }[] }>(
          "check_ingest_duplicate",
          { sourceRef: raw.sourceRef }
        );
        setDuplicateCheck(dup);
      } catch {
        // 중복 감지 실패는 무시
      }

      setStatus("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  async function processRaw(raw: IngestRaw) {
    setStatus("processing");
    try {
      const result = await ingestToNote(raw, llmConfig, vaultConfig.contextLimit);
      setDraftTitle(result.title);
      setDraftTags(result.tags.join(", "));
      setDraftMarkdown(result.markdown);
      setStatus("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  async function saveNote() {
    const title = draftTitle.trim();
    if (!title) {
      setTitleError("제목을 입력해 주세요.");
      return;
    }
    setTitleError(null);

    setStatus("saving");
    let createdPath: string | null = null;
    try {
      const tags = draftTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const markdown = applyTagsToMarkdown(draftMarkdown, tags);
      const createResult = await vaultApi.createNote("Ingested", title);
      if (!createResult.selectedPath) {
        throw new Error("생성된 노트 경로를 찾지 못했습니다.");
      }
      createdPath = createResult.selectedPath;
      await vaultApi.saveNote(createdPath, markdown, "");
      setVault(createResult.vault);
      setLastCreatedPath(createdPath);
      setStatus("done");
      await onIngested(createdPath);
    } catch (err) {
      if (createdPath) {
        try { await vaultApi.deleteEntry(createdPath); } catch { /* best effort cleanup */ }
      }
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  function handleUrlIngest() {
    if (!url.trim()) return;
    void fetchRaw(() => ingestUrl(url.trim()));
  }

  async function handlePdfIngest() {
    const selected = await openFileDialog({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      multiple: false,
    });
    if (!selected || typeof selected !== "string") return;
    void fetchRaw(() => ingestPdf(selected));
  }

  function handleRetry() {
    const rawErr = error ?? "";
    setError(null);
    if (rawErr.toLowerCase().includes("ollama did not respond") && rawPreview) {
      void processRaw(rawPreview);
    } else {
      setRawPreview(null);
      setStatus("idle");
    }
  }

  function reset() {
    setUrl("");
    setStatus("idle");
    setError(null);
    setTitleError(null);
    setLastCreatedPath(null);
    setRawPreview(null);
    setDraftTitle("");
    setDraftTags("");
    setDraftMarkdown("");
    setDuplicateCheck(null);
    setDuplicateDismissed(false);
  }

  const busy = status === "fetching" || status === "processing" || status === "saving";
  const canSave = draftTitle.trim().length > 0 && !busy;
  const labelStyle: CSSProperties = { fontSize: "0.8rem", color: "var(--text-muted, #888)" };

  const statusLabel: Partial<Record<IngestStatus, string>> = {
    fetching: "콘텐츠를 가져오는 중…",
    processing: "Ollama로 처리 중…",
    saving: "노트 저장 중…",
  };

  return (
    <div
      className="ingestPanelOverlay"
      role="dialog"
      aria-modal="true"
      aria-label="외부 콘텐츠 인제스트"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="ingestPanel">
        <div className="ingestPanelHeader">
          <h2 style={{ margin: 0, fontSize: "1rem" }}>Ingest</h2>
          <button
            className="ingestCloseBtn"
            onClick={onClose}
            aria-label="닫기"
            disabled={busy}
          >
            ✕
          </button>
        </div>

        {status === "done" && (
          <div className="ingestSuccess">
            <p>✓ 노트 저장됨{lastCreatedPath ? `: ${lastCreatedPath}` : ""}</p>
            <div style={{ display: "flex", gap: "8px" }}>
              <button className="primary" onClick={reset}>
                다시 인제스트
              </button>
              <button onClick={onClose}>닫기</button>
            </div>
          </div>
        )}

        {status === "preview" && duplicateCheck?.exactMatch && !duplicateDismissed && (
          <div className="duplicate-warning">
            <p>⚠️ 이미 수집된 콘텐츠입니다.</p>
            <div className="duplicate-actions">
              <button onClick={() => onIngested(duplicateCheck.exactMatch!)}>기존 노트 열기</button>
              <button onClick={() => setDuplicateDismissed(true)}>계속 진행</button>
            </div>
          </div>
        )}

        {status === "preview" && (duplicateCheck?.similarNotes?.length ?? 0) > 0 && (
          <p className="similar-warning">
            유사한 노트가 있습니다: {duplicateCheck!.similarNotes.map((n) => n.title).join(", ")}
          </p>
        )}

        {status === "preview" && rawPreview && (
          <div className="ingestPreview">
            <p style={{ fontSize: "0.8rem", color: "var(--text-muted, #888)", marginBottom: "4px" }}>
              출처: {rawPreview.sourceRef}
            </p>
            <div className="ingestPreviewText">
              {rawPreview.text.length > 500
                ? `${rawPreview.text.slice(0, 500)}… (전체 ${rawPreview.text.length.toLocaleString()}자)`
                : rawPreview.text}
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
              <button className="primary" onClick={() => void processRaw(rawPreview)}>
                처리하기
              </button>
              <button onClick={reset}>취소</button>
            </div>
          </div>
        )}

        {status === "review" && (
          <div className="ingestReview">
            <label style={labelStyle}>제목</label>
            <input
              className="ingestUrlInput"
              value={draftTitle}
              onChange={(e) => { setDraftTitle(e.target.value); setTitleError(null); }}
              style={{ marginBottom: titleError ? "4px" : "8px" }}
            />
            {titleError && (
              <p style={{ color: "var(--color-error, #e55)", fontSize: "0.8rem", margin: "0 0 8px" }}>
                {titleError}
              </p>
            )}
            <label style={labelStyle}>
              태그 (쉼표로 구분)
            </label>
            <input
              className="ingestUrlInput"
              value={draftTags}
              onChange={(e) => setDraftTags(e.target.value)}
              style={{ marginBottom: "8px" }}
            />
            <label style={labelStyle}>마크다운</label>
            <textarea
              className="ingestMarkdownEditor"
              value={draftMarkdown}
              onChange={(e) => setDraftMarkdown(e.target.value)}
              rows={10}
              style={{ width: "100%", resize: "vertical", maxHeight: "300px" }}
            />
            <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
              <button className="primary" onClick={() => void saveNote()} disabled={!canSave}>
                저장하기
              </button>
              <button
                onClick={() => rawPreview && void processRaw(rawPreview)}
                disabled={!rawPreview}
              >
                다시 생성
              </button>
            </div>
          </div>
        )}

        {status === "error" && error && (
          <div className="ingestError" role="alert">
            <p style={{ marginBottom: "8px" }}>{mapErrorMessage(error)}</p>
            <button onClick={handleRetry}>
              {error.toLowerCase().includes("ollama did not respond") && rawPreview ? "미리보기에서 재시도" : "다시 시도"}
            </button>
          </div>
        )}

        {(status === "idle" || status === "fetching" || status === "processing" || status === "saving") && (
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
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !busy && handleUrlIngest()}
                  disabled={busy}
                  style={{ flex: 1 }}
                />
                <button
                  className="primary"
                  onClick={handleUrlIngest}
                  disabled={busy || !url.trim()}
                >
                  Fetch
                </button>
              </div>
            </div>

            <div className="ingestDivider">또는</div>

            <div className="ingestSection">
              <label style={{ fontSize: "0.85rem", color: "var(--text-muted, #888)" }}>
                PDF 문서
              </label>
              <button
                onClick={() => void handlePdfIngest()}
                disabled={busy}
                style={{ alignSelf: "flex-start" }}
              >
                PDF 선택…
              </button>
            </div>

            {busy && (
              <div className="ingestProgress" aria-live="polite">
                <span className="ingestSpinner" /> {statusLabel[status]}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
