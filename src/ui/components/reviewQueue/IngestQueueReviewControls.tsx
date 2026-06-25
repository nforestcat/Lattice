import type {
  IngestQueueItem,
  IngestQueueUpdate,
  IngestSimilarNote,
  ReviewQueueItem,
} from "../../../api/types";

interface IngestQueueReviewControlsProps {
  readonly item: ReviewQueueItem;
  readonly onUpdate?: (id: string, patch: IngestQueueUpdate) => void;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isIngestQueueItem(value: unknown): value is IngestQueueItem {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["markdown"] === "string" &&
    typeof value["targetFolder"] === "string" &&
    "appendTargetPath" in value &&
    isRecord(value["raw"]) &&
    typeof value["raw"]["sourceRef"] === "string" &&
    Array.isArray(value["tags"]) &&
    Array.isArray(value["similarNotes"]) &&
    Array.isArray(value["suggestedLinks"])
  );
}

function firstSuggestedTarget(item: IngestQueueItem): string {
  return item.duplicateExact ?? item.suggestedLinks[0]?.path ?? item.similarNotes[0]?.path ?? "";
}

function formatTags(tags: readonly string[]): string {
  return tags.join(", ");
}

function parseTags(value: string): readonly string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function CandidateList({
  label,
  items,
  onSelect,
}: {
  readonly label: string;
  readonly items: readonly IngestSimilarNote[];
  readonly onSelect: (path: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {items.map((note) => (
          <button
            key={note.path}
            type="button"
            onClick={() => onSelect(note.path)}
            style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4 }}
            title={note.path}
          >
            {note.title}
          </button>
        ))}
      </div>
    </div>
  );
}

export function IngestQueueReviewControls({
  item,
  onUpdate,
}: IngestQueueReviewControlsProps) {
  if (!isIngestQueueItem(item.sourceRef)) return null;

  const ingest = item.sourceRef;
  const appendEnabled = ingest.appendTargetPath !== null;
  const canEdit = item.status === "drafted" || item.status === "approved";

  function update(patch: IngestQueueUpdate) {
    onUpdate?.(ingest.id, patch);
  }

  function selectAppendTarget(path: string) {
    update({ appendTargetPath: path });
  }

  return (
    <div
      style={{
        display: "grid",
        gap: 10,
        padding: "10px",
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: 4,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", fontSize: 12, color: "#475569" }}>
        <span><b>source:</b> {ingest.raw.sourceRef}</span>
        {ingest.raw.sourceType && <span><b>type:</b> {ingest.raw.sourceType}</span>}
        {ingest.raw.ingestDate && <span><b>date:</b> {ingest.raw.ingestDate}</span>}
        {ingest.duplicateExact && <span><b>duplicate:</b> {ingest.duplicateExact}</span>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) minmax(160px, 1fr)", gap: 8 }}>
        <label style={{ display: "grid", gap: 3, fontSize: 11, color: "#64748b", fontWeight: 700 }}>
          Target folder
          <input
            value={ingest.targetFolder}
            onChange={(event) => update({ targetFolder: event.currentTarget.value })}
            disabled={!canEdit || appendEnabled}
            style={{ padding: "5px 7px", borderRadius: 4, border: "1px solid #cbd5e1" }}
          />
        </label>
        <label style={{ display: "grid", gap: 3, fontSize: 11, color: "#64748b", fontWeight: 700 }}>
          Tags
          <input
            value={formatTags(ingest.tags)}
            onChange={(event) => update({ tags: parseTags(event.currentTarget.value) })}
            disabled={!canEdit}
            style={{ padding: "5px 7px", borderRadius: 4, border: "1px solid #cbd5e1" }}
          />
        </label>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#334155" }}>
        <input
          type="checkbox"
          checked={appendEnabled}
          disabled={!canEdit}
          onChange={(event) => update({ appendTargetPath: event.currentTarget.checked ? firstSuggestedTarget(ingest) : null })}
        />
        Append to existing note
      </label>

      {appendEnabled && (
        <input
          aria-label="Append target path"
          value={ingest.appendTargetPath ?? ""}
          onChange={(event) => update({ appendTargetPath: event.currentTarget.value })}
          disabled={!canEdit}
          placeholder="Notes/Existing.md"
          style={{ padding: "5px 7px", borderRadius: 4, border: "1px solid #cbd5e1", fontSize: 12 }}
        />
      )}

      <CandidateList label="Duplicate candidates" items={ingest.similarNotes} onSelect={selectAppendTarget} />
      <CandidateList label="Suggested links" items={ingest.suggestedLinks} onSelect={selectAppendTarget} />
    </div>
  );
}
