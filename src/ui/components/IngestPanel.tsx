import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { ingestPdf, ingestUrl } from "../../api/tauriVault";
import { ingestToNote } from "../../core/ingest";
import type { IngestRaw, IngestResult, LlmConfig, VaultConfig } from "../../api/types";
import { DuplicateWarning } from "./ingest/DuplicateWarning";
import { ReviewEditor } from "./ingest/ReviewEditor";
import { UrlPdfInputs } from "./ingest/UrlPdfInputs";
import { mapErrorMessage } from "./ingest/errorMessages";

interface IngestPanelProps {
  open: boolean;
  onClose: () => void;
  llmConfig: LlmConfig;
  vaultConfig: VaultConfig;
  enqueueIngest: (
    result: IngestResult,
    raw: IngestRaw,
    dup: { exactMatch: string | null; similarNotes: { path: string; title: string }[] } | null
  ) => string;
  onOpenReviewQueue?: () => void;
}

type IngestStatus =
  | "idle"
  | "fetching"
  | "preview"
  | "processing"
  | "review"
  | "queued"
  | "error";

export function IngestPanel({
  open,
  onClose,
  llmConfig,
  vaultConfig,
  enqueueIngest,
  onOpenReviewQueue,
}: IngestPanelProps) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<IngestStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [rawPreview, setRawPreview] = useState<IngestRaw | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [draftMarkdown, setDraftMarkdown] = useState("");
  const [duplicateCheck, setDuplicateCheck] = useState<{
    exactMatch: string | null;
    similarNotes: { path: string; title: string }[];
  } | null>(null);
  const [duplicateDismissed, setDuplicateDismissed] = useState(false);
  const [showRawExcerpt, setShowRawExcerpt] = useState(false);

  if (!open) return null;

  async function fetchRaw(getRaw: () => Promise<IngestRaw>) {
    setError(null);
    setDuplicateCheck(null);
    setDuplicateDismissed(false);
    setShowRawExcerpt(false);
    setStatus("fetching");
    try {
      const raw = await getRaw();
      setRawPreview(raw);

      let dup: { exactMatch: string | null; similarNotes: { path: string; title: string }[] } | null = null;
      try {
        dup = await invoke<{ exactMatch: string | null; similarNotes: { path: string; title: string }[] }>(
          "check_ingest_duplicate",
          { sourceRef: raw.sourceRef }
        );
        setDuplicateCheck(dup);
      } catch {
        // 중복 감지 실패는 무시
      }

      if (dup?.exactMatch) {
        setStatus("preview");
      } else {
        void processRaw(raw);
      }
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

  function handleEnqueue() {
    const title = draftTitle.trim();
    if (!title) {
      setTitleError("제목을 입력해 주세요.");
      return;
    }
    setTitleError(null);

    const tags = draftTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    enqueueIngest(
      { title, markdown: draftMarkdown, tags },
      rawPreview!,
      duplicateCheck
    );
    setStatus("queued");
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
    setRawPreview(null);
    setDraftTitle("");
    setDraftTags("");
    setDraftMarkdown("");
    setDuplicateCheck(null);
    setDuplicateDismissed(false);
    setShowRawExcerpt(false);
  }

  const busy = status === "fetching" || status === "processing";
  const canSave = draftTitle.trim().length > 0 && !busy;

  const statusLabel: Partial<Record<IngestStatus, string>> = {
    fetching: "콘텐츠를 가져오는 중…",
    processing: "Ollama로 처리 중…",
  };

  const reviewSimilarNotes =
    status === "review" && (duplicateCheck?.similarNotes?.length ?? 0) > 0
      ? duplicateCheck!.similarNotes
      : [];

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

        {status === "queued" && (
          <div className="ingestSuccess">
            <p>리뷰 큐에 추가됨 — 검토 후 승인하세요</p>
            <div style={{ display: "flex", gap: "8px" }}>
              {onOpenReviewQueue && (
                <button
                  className="primary"
                  onClick={() => { onOpenReviewQueue(); onClose(); }}
                >
                  리뷰 큐 열기
                </button>
              )}
              <button className="primary" onClick={reset}>
                다시 인제스트
              </button>
              <button onClick={onClose}>닫기</button>
            </div>
          </div>
        )}

        {status === "preview" && duplicateCheck?.exactMatch && !duplicateDismissed && (
          <DuplicateWarning
            exactMatch={duplicateCheck.exactMatch}
            onOpenExisting={() => onClose()}
            onContinue={() => {
              setDuplicateDismissed(true);
              if (rawPreview) void processRaw(rawPreview);
            }}
          />
        )}

        {status === "review" && (
          <ReviewEditor
            draftTitle={draftTitle}
            onTitleChange={setDraftTitle}
            titleError={titleError}
            onTitleErrorClear={() => setTitleError(null)}
            draftTags={draftTags}
            onTagsChange={setDraftTags}
            draftMarkdown={draftMarkdown}
            onMarkdownChange={setDraftMarkdown}
            similarNotes={reviewSimilarNotes}
            rawPreview={rawPreview}
            showRawExcerpt={showRawExcerpt}
            onToggleRawExcerpt={() => setShowRawExcerpt((v) => !v)}
            canSave={canSave}
            onSave={handleEnqueue}
            onRegenerate={() => rawPreview && void processRaw(rawPreview)}
          />
        )}

        {status === "error" && error && (
          <div className="ingestError" role="alert">
            <p style={{ marginBottom: "8px" }}>{mapErrorMessage(error)}</p>
            <button onClick={handleRetry}>
              {error.toLowerCase().includes("ollama did not respond") && rawPreview ? "미리보기에서 재시도" : "다시 시도"}
            </button>
          </div>
        )}

        {(status === "idle" || status === "fetching" || status === "processing") && (
          <UrlPdfInputs
            url={url}
            onUrlChange={setUrl}
            onUrlFetch={handleUrlIngest}
            onPdfSelect={() => void handlePdfIngest()}
            busy={busy}
            statusLabel={statusLabel[status]}
          />
        )}
      </div>
    </div>
  );
}
