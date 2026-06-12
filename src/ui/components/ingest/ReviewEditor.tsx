import { useState, type CSSProperties } from "react";
import type { IngestRaw } from "../../../api/types";
import { QualityBadges, computeQualityBadges } from "./QualityBadges";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { renderMarkdownPreview } from "../../markdownPreview";

interface ReviewEditorProps {
  draftTitle: string;
  onTitleChange: (v: string) => void;
  titleError: string | null;
  onTitleErrorClear: () => void;
  draftTags: string;
  onTagsChange: (v: string) => void;
  draftMarkdown: string;
  onMarkdownChange: (v: string) => void;
  similarNotes: { path: string; title: string }[];
  rawPreview: IngestRaw | null;
  showRawExcerpt: boolean;
  onToggleRawExcerpt: () => void;
  canSave: boolean;
  onSave: () => void;
  onRegenerate: () => void;
}

const labelStyle: CSSProperties = { fontSize: "0.8rem", color: "var(--text-muted, #888)" };

export function ReviewEditor({
  draftTitle,
  onTitleChange,
  titleError,
  onTitleErrorClear,
  draftTags,
  onTagsChange,
  draftMarkdown,
  onMarkdownChange,
  similarNotes,
  rawPreview,
  showRawExcerpt,
  onToggleRawExcerpt,
  canSave,
  onSave,
  onRegenerate,
}: ReviewEditorProps) {
  const [showPreview, setShowPreview] = useState(false);
  const badges = computeQualityBadges(draftMarkdown);

  function isNoteInserted(noteTitle: string): boolean {
    return draftMarkdown.includes(`[[${noteTitle}]]`);
  }

  function insertNoteLink(noteTitle: string) {
    if (isNoteInserted(noteTitle)) return;
    onMarkdownChange(`${draftMarkdown}\n\n관련: [[${noteTitle}]]`);
  }

  return (
    <div className="ingestReview">
      <QualityBadges badges={badges} />

      <label style={labelStyle}>제목</label>
      <input
        className="ingestUrlInput"
        value={draftTitle}
        onChange={(e) => { onTitleChange(e.target.value); onTitleErrorClear(); }}
        style={{ marginBottom: titleError ? "4px" : "8px" }}
      />
      {titleError && (
        <p style={{ color: "var(--color-error, #e55)", fontSize: "0.8rem", margin: "0 0 8px" }}>
          {titleError}
        </p>
      )}

      <label style={labelStyle}>태그 (쉼표로 구분)</label>
      <input
        className="ingestUrlInput"
        value={draftTags}
        onChange={(e) => onTagsChange(e.target.value)}
        style={{ marginBottom: "8px" }}
      />

      {similarNotes.length > 0 && (
        <div style={{ marginBottom: "8px" }}>
          <label style={labelStyle}>유사 노트 연결</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "4px" }}>
            {similarNotes.map((n) => {
              const inserted = isNoteInserted(n.title);
              return (
                <button
                  key={n.path}
                  onClick={() => insertNoteLink(n.title)}
                  disabled={inserted}
                  style={{ fontSize: "0.78rem", padding: "2px 8px" }}
                  title={n.path}
                >
                  {inserted ? "✓ " : ""}{n.title}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
        <label style={labelStyle}>마크다운</label>
        {rawPreview && (
          <button
            onClick={onToggleRawExcerpt}
            style={{ fontSize: "0.75rem", padding: "1px 6px", background: "none", border: "1px solid var(--border, #444)", borderRadius: "4px", cursor: "pointer", color: "var(--text-muted, #888)" }}
          >
            {showRawExcerpt ? "원문 닫기 ▲" : "원문 보기 ▶"}
          </button>
        )}
      </div>

      {showRawExcerpt && rawPreview && (
        <div
          style={{
            fontSize: "0.78rem",
            color: "var(--text-muted, #888)",
            background: "var(--bg-secondary, #1e1e1e)",
            border: "1px solid var(--border, #444)",
            borderRadius: "4px",
            padding: "8px",
            marginBottom: "6px",
            maxHeight: "140px",
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {rawPreview.text.length > 1000
            ? `${rawPreview.text.slice(0, 1000)}… (전체 ${rawPreview.text.length.toLocaleString()}자)`
            : rawPreview.text}
        </div>
      )}

      <CodeMirror
        value={draftMarkdown}
        height="200px"
        extensions={[markdown()]}
        theme="dark"
        basicSetup={{ lineNumbers: false, foldGutter: false }}
        onChange={onMarkdownChange}
        style={{ borderRadius: "6px", overflow: "hidden", marginBottom: "4px" }}
      />
      <div style={{ marginBottom: "8px" }}>
        <button
          onClick={() => setShowPreview((v) => !v)}
          style={{ fontSize: "0.75rem", padding: "1px 6px", background: "none", border: "1px solid var(--border, #444)", borderRadius: "4px", cursor: "pointer", color: "var(--text-muted, #888)" }}
        >
          {showPreview ? "미리보기 ▲" : "미리보기 ▶"}
        </button>
        {showPreview && (
          <article
            dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(draftMarkdown) }}
            style={{ maxHeight: "200px", overflowY: "auto", padding: "8px", border: "1px solid var(--border, #444)", borderRadius: "4px", fontSize: "0.85rem", marginTop: "4px" }}
          />
        )}
      </div>

      <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
        <button className="primary" onClick={onSave} disabled={!canSave}>
          저장하기
        </button>
        <button onClick={onRegenerate} disabled={!rawPreview}>
          다시 생성
        </button>
      </div>
    </div>
  );
}
