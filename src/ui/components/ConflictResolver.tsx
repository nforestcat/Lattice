import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type ConflictHunk = {
  index: number;
  ours: string;
  theirs: string;
  resolved: boolean;
  resolution: string | null;
  manualContent: string | null;
};

type ConflictFile = {
  path: string;
  hunks: ConflictHunk[];
};

interface ConflictResolverProps {
  open: boolean;
  onClose: () => void;
  onResolved: () => void;
}

const STATE_PATH = ".lattice/conflict-state.json";

export function ConflictResolver({ open, onClose, onResolved }: ConflictResolverProps) {
  const [conflictFiles, setConflictFiles] = useState<ConflictFile[]>([]);
  const [markedFiles, setMarkedFiles] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [editingHunk, setEditingHunk] = useState<{ path: string; index: number } | null>(null);
  const [manualContent, setManualContent] = useState("");

  // Load conflict state: try persisted state first, fall back to server
  useEffect(() => {
    if (!open) return;
    setLoading(true);

    async function load() {
      try {
        const raw = await invoke<string>("read_note", { path: STATE_PATH });
        const saved = JSON.parse(raw) as { files: ConflictFile[]; savedAt: string };
        if (saved.files && saved.files.length > 0) {
          setConflictFiles(saved.files);
          setLoading(false);
          return;
        }
      } catch {
        // No saved state — load fresh from server
      }

      try {
        const files = await invoke<ConflictFile[]>("get_conflict_files");
        setConflictFiles(files ?? []);
      } catch (err) {
        console.error("Failed to load conflict files", err);
        setConflictFiles([]);
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [open]);

  // Persist state whenever files change
  useEffect(() => {
    if (!open || conflictFiles.length === 0) return;
    const state = { files: conflictFiles, savedAt: new Date().toISOString() };
    void invoke("save_note", {
      path: STATE_PATH,
      content: JSON.stringify(state),
      baseRevision: "",
    }).catch(() => {
      // best-effort, ignore failures
    });
  }, [conflictFiles, open]);

  // When all files resolved, call onResolved
  useEffect(() => {
    if (!open || conflictFiles.length === 0) return;
    const allMarked = conflictFiles.every(
      (f) => f.hunks.every((h) => h.resolved) && markedFiles.has(f.path)
    );
    if (allMarked) {
      onResolved();
    }
  }, [conflictFiles, markedFiles, open, onResolved]);

  async function resolveHunk(
    path: string,
    hunkIndex: number,
    resolution: "ours" | "theirs" | "manual",
    content?: string
  ) {
    try {
      const updated = await invoke<ConflictFile>("resolve_conflict_hunk", {
        path,
        hunkIndex,
        resolution,
        manualContent: content ?? null,
      });
      setConflictFiles((prev) =>
        prev.map((f) => (f.path === path ? updated : f))
      );
      if (editingHunk?.path === path && editingHunk.index === hunkIndex) {
        setEditingHunk(null);
        setManualContent("");
      }
    } catch (err) {
      console.error("Failed to resolve hunk", err);
    }
  }

  async function undoHunk(filePath: string, _hunkIndex: number) {
    try {
      const files = await invoke<ConflictFile[]>("get_conflict_files");
      setConflictFiles((prev) =>
        prev.map((f) =>
          f.path === filePath
            ? (files.find((ff) => ff.path === filePath) ?? f)
            : f
        )
      );
    } catch (err) {
      console.error("Failed to undo hunk", err);
    }
  }

  async function markResolved(path: string) {
    try {
      await invoke("mark_conflict_resolved", { path });
      setMarkedFiles((prev) => new Set([...prev, path]));
    } catch (err) {
      console.error("Failed to mark conflict resolved", err);
    }
  }

  function startEditHunk(path: string, index: number, initialContent: string) {
    setEditingHunk({ path, index });
    setManualContent(initialContent);
  }

  if (!open) return null;

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div
        className="modalContent conflict-resolver"
        style={{ maxWidth: 760, width: "100%", maxHeight: "80vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="conflict-resolver-header modalHeader">
          <h3>충돌 해결</h3>
          <button className="closeButton" onClick={onClose}>&times;</button>
        </div>

        {loading && <p className="muted" style={{ padding: "1rem" }}>충돌 파일 로드 중...</p>}

        {!loading && conflictFiles.length === 0 && (
          <p className="muted" style={{ padding: "1rem" }}>충돌이 없습니다.</p>
        )}

        {!loading && conflictFiles.map((file) => {
          const allResolved = file.hunks.every((h) => h.resolved);
          const isMarked = markedFiles.has(file.path);

          return (
            <div key={file.path} className="conflict-file" style={{ padding: "1rem", borderBottom: "1px solid var(--border-color, #e0e0e0)" }}>
              <h4 style={{ marginBottom: "0.5rem", fontFamily: "monospace", fontSize: "0.9rem" }}>
                {file.path}
                {isMarked && <span style={{ marginLeft: "0.5rem", color: "var(--success-color, #4caf50)", fontSize: "0.8rem" }}>✓ git add 완료</span>}
              </h4>

              {file.hunks.map((hunk) => {
                const isEditing = editingHunk?.path === file.path && editingHunk.index === hunk.index;

                return (
                  <div
                    key={hunk.index}
                    className={`conflict-hunk${hunk.resolved ? " resolved" : ""}`}
                    style={{
                      border: "1px solid var(--border-color, #e0e0e0)",
                      borderRadius: 4,
                      marginBottom: "0.75rem",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      className="hunk-header"
                      style={{
                        padding: "0.4rem 0.75rem",
                        background: hunk.resolved
                          ? "var(--resolved-bg, #e8f5e9)"
                          : "var(--hunk-header-bg, #f5f5f5)",
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                        fontSize: "0.85rem",
                      }}
                    >
                      <span>Hunk #{hunk.index + 1}</span>
                      {hunk.resolved && (
                        <span
                          className="resolved-badge"
                          style={{ color: "var(--success-color, #4caf50)", fontWeight: 600 }}
                        >
                          ✓ {hunk.resolution}
                        </span>
                      )}
                    </div>

                    {!hunk.resolved && (
                      <div
                        className="hunk-diff"
                        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}
                      >
                        <div
                          className="hunk-ours"
                          style={{
                            padding: "0.5rem",
                            borderRight: "1px solid var(--border-color, #e0e0e0)",
                            background: "var(--ours-bg, #fff3cd)",
                          }}
                        >
                          <label style={{ fontSize: "0.75rem", fontWeight: 600, display: "block", marginBottom: "0.25rem" }}>
                            Ours
                          </label>
                          <pre style={{ margin: 0, fontSize: "0.8rem", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                            {hunk.ours}
                          </pre>
                        </div>
                        <div
                          className="hunk-theirs"
                          style={{
                            padding: "0.5rem",
                            background: "var(--theirs-bg, #cce5ff)",
                          }}
                        >
                          <label style={{ fontSize: "0.75rem", fontWeight: 600, display: "block", marginBottom: "0.25rem" }}>
                            Theirs
                          </label>
                          <pre style={{ margin: 0, fontSize: "0.8rem", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                            {hunk.theirs}
                          </pre>
                        </div>
                      </div>
                    )}

                    {isEditing && (
                      <div style={{ padding: "0.5rem" }}>
                        <textarea
                          value={manualContent}
                          onChange={(e) => setManualContent(e.target.value)}
                          style={{
                            width: "100%",
                            minHeight: 100,
                            fontFamily: "monospace",
                            fontSize: "0.85rem",
                            boxSizing: "border-box",
                          }}
                        />
                      </div>
                    )}

                    <div
                      className="hunk-actions"
                      style={{ padding: "0.5rem 0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
                    >
                      {!hunk.resolved ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void resolveHunk(file.path, hunk.index, "ours")}
                          >
                            Accept Ours
                          </button>
                          <button
                            type="button"
                            onClick={() => void resolveHunk(file.path, hunk.index, "theirs")}
                          >
                            Accept Theirs
                          </button>
                          <button
                            type="button"
                            onClick={() => startEditHunk(file.path, hunk.index, hunk.ours)}
                          >
                            Edit Manually
                          </button>
                          {isEditing && (
                            <button
                              type="button"
                              onClick={() => void resolveHunk(file.path, hunk.index, "manual", manualContent)}
                            >
                              Apply
                            </button>
                          )}
                        </>
                      ) : (
                        <button type="button" onClick={() => void undoHunk(file.path, hunk.index)}>
                          Undo
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              <button
                type="button"
                disabled={!allResolved || isMarked}
                onClick={() => void markResolved(file.path)}
                style={{ marginTop: "0.25rem" }}
              >
                {isMarked ? "✓ Marked Resolved" : "Mark as Resolved → git add"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
