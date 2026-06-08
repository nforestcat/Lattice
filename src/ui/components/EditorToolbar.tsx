import type { NoteContext, VaultConfig } from "../../api/types";

interface EditorToolbarProps {
  viewMode: "split" | "edit" | "preview" | "graph" | "distill";
  setViewMode: (mode: "split" | "edit" | "preview" | "graph" | "distill") => void;
  context: NoteContext | null;
  activePath: string | null;
  vaultConfig: VaultConfig;
  DEFAULT_NOTE_TEMPLATES: Array<{ name: string; description: string; prompt: string }>;
  isAutofillingTemplate: boolean;
  autofillActiveNoteWithTemplate: (templateName: string) => Promise<void> | void;
  saveActiveNote: () => Promise<void> | void;
}

export function EditorToolbar({
  viewMode,
  setViewMode,
  context,
  activePath,
  vaultConfig,
  DEFAULT_NOTE_TEMPLATES,
  isAutofillingTemplate,
  autofillActiveNoteWithTemplate,
  saveActiveNote,
}: EditorToolbarProps) {
  return (
    <header className="topbar">
      <div>
        <strong>{viewMode === "distill" ? "LLM Distill Workspace" : (context?.note.title ?? "Select a note")}</strong>
        <span>{viewMode === "distill" ? "Compounding Memory Pipeline" : activePath}</span>
      </div>
      <div className="segmented">
        <button className={viewMode === "split" ? "active" : ""} onClick={() => setViewMode("split")}>Split</button>
        <button className={viewMode === "edit" ? "active" : ""} onClick={() => setViewMode("edit")}>Edit</button>
        <button className={viewMode === "preview" ? "active" : ""} onClick={() => setViewMode("preview")}>Preview</button>
        <button className={viewMode === "graph" ? "active" : ""} onClick={() => setViewMode("graph")}>Graph</button>
        <button className={viewMode === "distill" ? "active" : ""} onClick={() => setViewMode("distill")}>Distill</button>
      </div>
      {viewMode !== "distill" && activePath && (
        <div className="templateSelectorContainer" style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
          <select
            className="templateSelect"
            value=""
            onChange={(e) => {
              const tName = e.target.value;
              if (tName) void autofillActiveNoteWithTemplate(tName);
            }}
            disabled={isAutofillingTemplate}
            style={{
              fontSize: "12px",
              padding: "4px 8px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1"
            }}
          >
            <option value="">{isAutofillingTemplate ? "Autofilling..." : "Apply Template..."}</option>
            {(vaultConfig.noteTemplates || DEFAULT_NOTE_TEMPLATES).map((t) => (
              <option key={t.name} value={t.name}>{t.name}</option>
            ))}
          </select>
          <button className="primary" onClick={() => void saveActiveNote()}>Save</button>
        </div>
      )}
      {viewMode !== "distill" && !activePath && (
        <button className="primary" disabled>Save</button>
      )}
    </header>
  );
}
