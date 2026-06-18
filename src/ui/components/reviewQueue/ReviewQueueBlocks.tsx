import type { AiProvenance } from "../../../api/types";

export function ProvenanceBlock({ provenance }: { readonly provenance?: AiProvenance }) {
  if (provenance === undefined) {
    return (
      <div style={{ fontSize: 11, color: "#94a3b8", padding: "4px 8px", background: "#f8fafc", borderRadius: 4, border: "1px solid #e2e8f0" }}>
        출처 없음 (no provenance recorded)
      </div>
    );
  }

  const isUnlinked = provenance.promptRunId === null;

  return (
    <div style={{ fontSize: 11, color: "#475569", padding: "6px 10px", background: "#f8fafc", borderRadius: 4, border: "1px solid #e2e8f0", display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
      {isUnlinked && (
        <span style={{ background: "#fef3c7", color: "#92400e", borderRadius: 3, padding: "1px 6px", fontWeight: 600 }}>
          unlinked prompt
        </span>
      )}
      <span><b>출처:</b> {provenance.source}</span>
      {provenance.model && <span><b>모델:</b> {provenance.model}</span>}
      {provenance.confidence !== undefined && <span><b>신뢰도:</b> {(provenance.confidence * 100).toFixed(0)}%</span>}
      {provenance.appliedAt && <span><b>적용:</b> {new Date(provenance.appliedAt).toLocaleString()}</span>}
      {provenance.originalExcerpt && (
        <span style={{ width: "100%", fontStyle: "italic", color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          원문: {provenance.originalExcerpt.slice(0, 80)}{provenance.originalExcerpt.length > 80 ? "..." : ""}
        </span>
      )}
    </div>
  );
}

export function DiffBlock({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone: "add" | "remove";
}) {
  const styles =
    tone === "add"
      ? { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#14532d" }
      : { background: "#fef2f2", border: "1px solid #fecaca", color: "#7f1d1d" };

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>{label}</div>
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          borderRadius: 4,
          fontSize: 12,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          ...styles,
        }}
      >
        {value}
      </pre>
    </div>
  );
}
