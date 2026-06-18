import type { VaultConfig, PromptRun, ContextBundle } from "../../api/types";

export interface DiffLine {
  type: "added" | "removed" | "normal" | "unchanged";
  value: string;
}

export interface PromptHistoryPanelProps {
  vaultConfig: VaultConfig;
  activePath: string | null;
  archiveStatus: { fileCount: number; totalBytes: number } | null;
  historySearchQuery: string;
  setHistorySearchQuery: (q: string) => void;
  historyActiveNoteOnly: boolean;
  setHistoryActiveNoteOnly: (b: boolean) => void;
  historyPresetFilter: string;
  setHistoryPresetFilter: (p: string) => void;
  expandedRunId: string | null;
  setExpandedRunId: (id: string | null) => void;
  diffRunId: string | null;
  setDiffRunId: (id: string | null) => void;
  diffResult: { lines: DiffLine[]; regenerating: boolean; error?: string } | null;
  currentPromptHash: string | null;
  contextBundle: ContextBundle | null;
  promptInstruction: string;
  
  selectNote: (path: string) => Promise<void>;
  applyPromptRun: (run: PromptRun) => Promise<void>;
  copyPromptRunQuestion: (run: PromptRun) => void;
  copyFullPromptFromHistory: (run: PromptRun) => Promise<void>;
  deletePromptRun: (runId: string, e: React.MouseEvent) => Promise<void>;
  loadPromptDiff: (run: PromptRun) => Promise<void>;
  pruneArchivedPrompts: () => Promise<void>;
  exportPromptRuns: () => Promise<void>;
  handleImportArchiveFile: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  buildCombinedPrompt: (instruction: string, bundleMarkdown: string) => string;
}

export function PromptHistoryPanel({
  vaultConfig,
  activePath,
  archiveStatus,
  historySearchQuery,
  setHistorySearchQuery,
  historyActiveNoteOnly,
  setHistoryActiveNoteOnly,
  historyPresetFilter,
  setHistoryPresetFilter,
  expandedRunId,
  setExpandedRunId,
  diffRunId,
  setDiffRunId,
  diffResult,
  currentPromptHash,
  contextBundle,
  promptInstruction,
  selectNote,
  applyPromptRun,
  copyPromptRunQuestion,
  copyFullPromptFromHistory,
  deletePromptRun,
  loadPromptDiff,
  pruneArchivedPrompts,
  exportPromptRuns,
  handleImportArchiveFile,
  buildCombinedPrompt
}: PromptHistoryPanelProps) {
  const filteredPromptRuns = (vaultConfig.promptRuns ?? []).filter(run => {
    if (historySearchQuery.trim()) {
      const q = historySearchQuery.toLowerCase();
      const matchQuestion = run.question.toLowerCase().includes(q);
      const matchPreset = run.preset.toLowerCase().includes(q);
      const matchNote = run.activePath.toLowerCase().includes(q);
      if (!matchQuestion && !matchPreset && matchNote) {
        // match
      } else if (!matchQuestion && !matchPreset && !matchNote) {
        return false;
      }
    }
    if (historyActiveNoteOnly && activePath && run.activePath !== activePath) {
      return false;
    }
    if (historyPresetFilter && run.preset !== historyPresetFilter) {
      return false;
    }
    return true;
  });

  return (
    <section className="promptHistorySection">
      <h2>Prompt History</h2>
      {(!vaultConfig.promptRuns || vaultConfig.promptRuns.length === 0) ? (
        <p className="muted">No history yet</p>
      ) : (
        <>
          {archiveStatus && (
            <div className="archiveStatusBar">
              <span className="archiveStatusText">
                📁 Archive: <strong>{archiveStatus.fileCount}</strong> file(s) ({(archiveStatus.totalBytes / 1024).toFixed(1)} KB)
              </span>
              <div className="archiveActions">
                <button
                  className="smallButton exportButton"
                  onClick={() => void exportPromptRuns()}
                  title="Export prompt runs as a JSON file"
                >
                  Export
                </button>
                <button
                  className="smallButton importButton"
                  onClick={() => window.document.getElementById("promptArchiveImportInput")?.click()}
                  title="Import prompt runs from a JSON file"
                >
                  Import
                </button>
                <input
                  id="promptArchiveImportInput"
                  type="file"
                  accept=".json"
                  style={{ display: "none" }}
                  onChange={(e) => void handleImportArchiveFile(e)}
                />
                <button
                  className="smallButton pruneButton"
                  onClick={() => void pruneArchivedPrompts()}
                  title="Clean up disk files of deleted prompt runs"
                >
                  Prune Orphaned
                </button>
              </div>
            </div>
          )}
          <div className="historyFilters">
            <input
              type="text"
              placeholder="Search history..."
              value={historySearchQuery}
              onChange={(e) => setHistorySearchQuery(e.target.value)}
              className="historySearchField"
            />
            <div className="historyFilterControls">
              <label className="historyFilterCheckbox">
                <input
                  type="checkbox"
                  checked={historyActiveNoteOnly}
                  onChange={(e) => setHistoryActiveNoteOnly(e.target.checked)}
                />
                <span>Active note only</span>
              </label>
              <select
                value={historyPresetFilter}
                onChange={(e) => setHistoryPresetFilter(e.target.value)}
                className="historyPresetSelect"
              >
                <option value="">All presets</option>
                {Array.from(new Set((vaultConfig.promptRuns ?? []).map((r) => r.preset))).map((preset) => (
                  <option key={preset} value={preset}>{preset}</option>
                ))}
              </select>
            </div>
          </div>

          {filteredPromptRuns.length === 0 ? (
            <p className="muted">No matching history found</p>
          ) : (
            <div className="promptRunList">
              {filteredPromptRuns.map((run) => (
                <div 
                  key={run.id} 
                  className={`promptRunCard ${expandedRunId === run.id ? "expanded" : ""}`}
                  style={{ cursor: "pointer" }}
                  onClick={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
                >
                  <div className="promptRunHeader">
                    <span className="promptRunTime" title={run.createdAt}>
                      {new Date(run.createdAt).toLocaleString()}
                    </span>
                    <span className="promptRunMetaBadge">{run.preset} / {run.mode}</span>
                  </div>
                  <div className="promptRunQuestion">
                    {run.question ? run.question : <span className="muted italic">No question (bundle only)</span>}
                  </div>
                  <div className="promptRunDetails">
                    <span className="promptRunNoteLink" title="Click to view note" onClick={(e) => { e.stopPropagation(); void selectNote(run.activePath); }}>
                      [[{run.activePath.split('/').pop() || run.activePath}]]
                    </span>
                    <span className="promptRunTokens">{run.tokenCount.toLocaleString()} tokens</span>
                  </div>
                  <div className="promptRunActions" onClick={(e) => e.stopPropagation()}>
                    <button className="smallButton" onClick={() => void applyPromptRun(run)}>
                      Load
                    </button>
                    <button className="smallButton" onClick={() => void copyPromptRunQuestion(run)}>
                      Copy Question
                    </button>
                    <button className="smallButton" onClick={() => void copyFullPromptFromHistory(run)}>
                      Copy Full Prompt
                    </button>
                    <button className="smallButton dangerButton" onClick={(e) => void deletePromptRun(run.id, e)}>
                      Delete
                    </button>
                  </div>
                  {expandedRunId === run.id && (
                    <div className="promptRunExpandedPanel" onClick={(e) => e.stopPropagation()}>
                      {run.promptHash && (
                        <div className="expandedMetaRow">
                          <strong>Hash:</strong> <code>{run.promptHash}</code>
                        </div>
                      )}
                      <div className="expandedMetaRow">
                        <strong>Included Notes ({run.selectedNotes.length}):</strong>
                        <div className="expandedNotesList">
                          {run.selectedNotes.map(p => (
                            <span key={p} className="expandedNoteBadge">{p.split('/').pop() || p}</span>
                          ))}
                        </div>
                      </div>
                      {run.preview && (
                        <div className="expandedPreviewWrapper">
                          <strong>Prompt Preview (First 1.5 KB):</strong>
                          <textarea readOnly value={run.preview} className="expandedPreviewTextarea" />
                        </div>
                      )}
                      {contextBundle ? (() => {
                        const currentCombined = buildCombinedPrompt(promptInstruction, contextBundle.markdown);
                        const currentHash = currentPromptHash ?? "calculating";
                        const hashesMatch = Boolean(currentPromptHash && run.promptHash && currentPromptHash === run.promptHash);
                        
                        const addedNotes = contextBundle.notePaths.filter(p => !new Set(run.selectedNotes).has(p));
                        const removedNotes = run.selectedNotes.filter(p => !new Set(contextBundle.notePaths).has(p));
                        
                        const instructionDiffers = promptInstruction.trim() !== run.question.trim();
                        
                        return (
                          <div className="historyDiffContainer">
                            <div className="diffHeader">
                              <strong>🔍 Session Comparison</strong>
                              {hashesMatch ? (
                                <span className="diffStatusBadge match">🟢 Exact Match</span>
                              ) : (
                                <span className="diffStatusBadge modified">🟡 Modified</span>
                              )}
                            </div>
                            
                            {!hashesMatch && (
                              <div className="diffDetails">
                                <div className="diffRow">
                                  <span className="diffLabel">Prompt Hash:</span>
                                  <div className="diffValue">
                                    <span className="hashStored">{run.promptHash || "none"}</span>
                                    <span className="hashArrow">➔</span>
                                    <span className="hashCurrent">{currentHash}</span>
                                  </div>
                                </div>

                                {instructionDiffers && (
                                  <div className="diffRow instructionDiff">
                                    <span className="diffLabel">Instruction Text:</span>
                                    <div className="diffValueText">
                                      <div className="diffTextRemoved">- {run.question || "(empty)"}</div>
                                      <div className="diffTextAdded">+ {promptInstruction || "(empty)"}</div>
                                    </div>
                                  </div>
                                )}

                                {(addedNotes.length > 0 || removedNotes.length > 0) && (
                                  <div className="diffRow notesDiff">
                                    <span className="diffLabel">Notes Changes:</span>
                                    <div className="diffNotesDelta">
                                      {removedNotes.map(n => (
                                        <span key={n} className="diffNoteBadge removed">-{n.split('/').pop() || n}</span>
                                      ))}
                                      {addedNotes.map(n => (
                                        <span key={n} className="diffNoteBadge added">+{n.split('/').pop() || n}</span>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {run.preview && (
                                  <div className="diffRow previewDiff">
                                    <span className="diffLabel">Preview Comparison (Stored vs Current):</span>
                                    <div className="diffPreviewsSplit">
                                      <div className="diffPreviewBox stored">
                                        <div className="boxTitle">Stored Run</div>
                                        <pre>{run.preview}</pre>
                                      </div>
                                      <div className="diffPreviewBox current">
                                        <div className="boxTitle">Current Session</div>
                                        <pre>{currentCombined.slice(0, 1500) + (currentCombined.length > 1500 ? "..." : "")}</pre>
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                            
                            <div className="diffFullTextCompareSection">
                              <button
                                className="smallButton secondary"
                                onClick={() => void loadPromptDiff(run)}
                                style={{ marginTop: "8px" }}
                              >
                                {diffRunId === run.id ? "Hide Full Text Diff" : "Compare Full Text (Exact)"}
                              </button>

                              {diffRunId === run.id && diffResult && (
                                <div className="fullPromptDiffWrapper">
                                  <div className="diffHeader">
                                    <strong>Unified Prompt Diff</strong>
                                    {diffResult.regenerating && <span className="diffRegenText">Retrieving/Regenerating...</span>}
                                  </div>
                                  {diffResult.error ? (
                                    <div className="diffErrorText">{diffResult.error}</div>
                                  ) : (
                                    <div className="fullPromptDiffBox">
                                      {diffResult.lines.map((line, idx) => (
                                        <div key={idx} className={`diffLine ${line.type}`}>
                                          <span className="diffPrefix">
                                            {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                                          </span>
                                          <span className="diffContent">{line.value}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })() : (
                        <div className="historyDiffContainer muted italic">
                          Generate a bundle in the current workspace to compare with this historical run.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
