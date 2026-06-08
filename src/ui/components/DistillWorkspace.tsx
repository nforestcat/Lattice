import { useState, useEffect } from "react";
import type { VaultSnapshot, LlmConfig, LlmProvider, VaultConfig, ContextBundle, ProposedEdit, UnresolvedLinkGroup, NoteHealthReport, StubDraftReview, GitStatus, GitFileChange } from "../../api/types";
import type { ChatMessage } from "../../api/llm";
import { vaultApi } from "../../api";
import { LlmSettingsPanel } from "./LlmSettingsPanel";
import { GitWorkspace } from "./GitWorkspace";
import { sendChatMessage } from "../../api/llm";

interface DistillWorkspaceProps {
  onSelectNote?: (path: string) => Promise<void>;
  onRefreshVault?: () => Promise<void>;
  vault: VaultSnapshot | null;
  activePath: string | null;
  llmConfig: LlmConfig;
  setLlmConfig: React.Dispatch<React.SetStateAction<LlmConfig>>;
  vaultConfig: VaultConfig;
  updateVaultConfig: (updates: Partial<VaultConfig>) => Promise<void>;
  saveStoredLlmApiKey: (provider: LlmProvider, apiKey: string) => void;
  readStoredLlmApiKey: (provider: LlmProvider) => string;
  redactLlmConfig: (config: LlmConfig) => LlmConfig;
  pruneExpiredPromptRuns: (policy: string) => Promise<void>;
  setStatus: (status: string) => void;
  contextBundle: ContextBundle | null;

  distillTab: "paste" | "chat" | "auditor" | "git";
  setDistillTab: (tab: "paste" | "chat" | "auditor" | "git") => void;
  gitStatus: GitStatus | null;
  gitChanges: GitFileChange[];
  selectedGitFile: string | null;
  selectedGitFileStaged: boolean;
  activeDiff: string | null;
  commitMessage: string;
  isGitLoading: boolean;
  gitOutputLog: string | null;
  setCommitMessage: (msg: string) => void;
  setSelectedGitFile: (path: string | null) => void;
  setSelectedGitFileStaged: (staged: boolean) => void;
  setGitOutputLog: (log: string | null) => void;
  onRefreshGit: () => Promise<void>;
  onStageAll: () => Promise<void>;
  onCommit: (message: string) => Promise<void>;
  onPull: () => Promise<void>;
  onPush: () => Promise<void>;
  onLoadDiff: (path: string, staged: boolean) => Promise<void>;
  distillInputText: string;
  setDistillInputText: (text: string) => void;
  proposedEdits: ProposedEdit[];
  setProposedEdits: React.Dispatch<React.SetStateAction<ProposedEdit[]>>;
  applyCheckedEdits: () => Promise<void>;

  chatMessages: ChatMessage[];
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  chatInput: string;
  setChatInput: (text: string) => void;
  isLlmGenerating: boolean;
  setIsLlmGenerating: (generating: boolean) => void;
  includeContext: boolean;
  setIncludeContext: (include: boolean) => void;
  clearChatHistory: () => void;
  handleSendChatMessage: () => Promise<void>;

  showLlmSettings: boolean;
  setShowLlmSettings: (show: boolean) => void;

  unresolvedLinks: UnresolvedLinkGroup[];
  isScanningUnresolved: boolean;
  selectedUnresolvedTargets: Set<string>;
  setSelectedUnresolvedTargets: React.Dispatch<React.SetStateAction<Set<string>>>;
  bulkDrafts: Record<string, StubDraftReview>;
  setBulkDrafts: React.Dispatch<React.SetStateAction<Record<string, StubDraftReview>>>;
  isBulkProcessing: boolean;
  runUnresolvedLinksScan: () => Promise<UnresolvedLinkGroup[]>;
  handleSelectAllToggle: (e: React.ChangeEvent<HTMLInputElement>) => void;
  runBulkDrafting: () => Promise<void>;
  createSelectedStubs: () => Promise<void>;
  draftStubNote: (target: string, sources: Array<{ path: string; title: string; excerpt: string }>) => Promise<void>;
  approveDraft: (target: string) => void;
  rejectDraft: (target: string) => void;
  approveAllDrafts: () => void;
  rejectAllDrafts: () => void;

  healthReports: NoteHealthReport[];
  isScanningHealth: boolean;
  onRunHealthAudit: () => Promise<void>;
  auditorSubTab: "health" | "links";
  setAuditorSubTab: (tab: "health" | "links") => void;
}

export function DistillWorkspace({
  vault,
  activePath,
  llmConfig,
  setLlmConfig,
  vaultConfig,
  updateVaultConfig,
  saveStoredLlmApiKey,
  readStoredLlmApiKey,
  redactLlmConfig,
  pruneExpiredPromptRuns,
  setStatus,
  contextBundle,
  distillTab,
  setDistillTab,
  distillInputText,
  setDistillInputText,
  proposedEdits,
  setProposedEdits,
  applyCheckedEdits,
  chatMessages,
  setChatMessages,
  chatInput,
  setChatInput,
  isLlmGenerating,
  includeContext,
  setIncludeContext,
  clearChatHistory,
  handleSendChatMessage,
  showLlmSettings,
  setShowLlmSettings,
  unresolvedLinks,
  isScanningUnresolved,
  selectedUnresolvedTargets,
  setSelectedUnresolvedTargets,
  bulkDrafts,
  setBulkDrafts,
  isBulkProcessing,
  runUnresolvedLinksScan,
  handleSelectAllToggle,
  runBulkDrafting,
  createSelectedStubs,
  draftStubNote,
  onSelectNote,
  onRefreshVault,
  healthReports,
  isScanningHealth,
  onRunHealthAudit,
  auditorSubTab,
  setAuditorSubTab,
  approveDraft,
  rejectDraft,
  approveAllDrafts,
  rejectAllDrafts,
  gitStatus,
  gitChanges,
  selectedGitFile,
  selectedGitFileStaged,
  activeDiff,
  commitMessage,
  isGitLoading,
  gitOutputLog,
  setCommitMessage,
  setSelectedGitFile,
  setSelectedGitFileStaged,
  setGitOutputLog,
  onRefreshGit,
  onStageAll,
  onCommit,
  onPull,
  onPush,
  onLoadDiff
}: DistillWorkspaceProps) {
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());
  const [generatingSummaryPath, setGeneratingSummaryPath] = useState<string | null>(null);

  const approvedCount = Array.from(selectedUnresolvedTargets).filter(t => {
    const draft = bulkDrafts[t];
    return draft?.status === "done" && draft?.approved;
  }).length;

  const hasDoneDrafts = Object.values(bulkDrafts).some(d => d.status === "done");


  const handleGenerateSummary = async (path: string) => {
    setGeneratingSummaryPath(path);
    setStatus(`Reading note ${path}...`);
    try {
      const doc = await vaultApi.readNote(path);
      setStatus(`Generating summary for ${path} using LLM...`);
      const prompt = `Below is the content of a wiki note. Please write a concise, one-sentence summary of this note to be stored in its frontmatter. Return ONLY the summary text, with no preamble, no markdown formatting, and no quotes.\n\nNote Content:\n${doc.content}`;
      
      const summary = await sendChatMessage(llmConfig, [
        { role: "user", content: prompt }
      ]);
      
      const cleanSummary = summary.replace(/^["'\s]+|["'\s]+$/g, "").trim();
      setStatus(`Applying summary to frontmatter of ${path}...`);
      await vaultApi.applyNoteMetadata(path, { summary: cleanSummary }, []);
      setStatus(`Successfully summarized and updated frontmatter for ${path}!`);
      
      await onRunHealthAudit();
      if (onRefreshVault) {
        await onRefreshVault();
      }
    } catch (e) {
      console.error(e);
      setStatus(`Failed to generate summary: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGeneratingSummaryPath(null);
    }
  };

  const handleFindLinkSuggestions = async (path: string) => {
    if (onSelectNote) {
      await onSelectNote(path);
    }
    setStatus(`Selected note ${path} to inspect link recommendations.`);
  };

  useEffect(() => {
    if (distillTab === "auditor") {
      void onRunHealthAudit();
    }
  }, [distillTab, vault?.rootPath]);

  return (
    <section className="distillSurface">
      <div className="distillTabHeader" style={{ padding: "0 16px 8px 16px", borderBottom: "1px solid #cbd5e1", marginBottom: 12 }}>
        <button
          className={distillTab === "paste" ? "active" : ""}
          onClick={() => setDistillTab("paste")}
        >
          Paste Raw Input
        </button>
        <button
          className={distillTab === "chat" ? "active" : ""}
          onClick={() => setDistillTab("chat")}
        >
          Chat with LLM
        </button>
        <button
          className={distillTab === "auditor" ? "active" : ""}
          onClick={() => {
            setDistillTab("auditor");
            void runUnresolvedLinksScan();
            void onRunHealthAudit();
          }}
        >
          Wiki Auditor
        </button>
        <button
          className={distillTab === "git" ? "active" : ""}
          onClick={() => {
            setDistillTab("git");
            void onRefreshGit();
          }}
        >
          Git Workspace
        </button>
      </div>

      {distillTab === "git" ? (
        <GitWorkspace
          gitStatus={gitStatus}
          gitChanges={gitChanges}
          selectedGitFile={selectedGitFile}
          selectedGitFileStaged={selectedGitFileStaged}
          activeDiff={activeDiff}
          commitMessage={commitMessage}
          isGitLoading={isGitLoading}
          gitOutputLog={gitOutputLog}
          setCommitMessage={setCommitMessage}
          setSelectedGitFile={setSelectedGitFile}
          setSelectedGitFileStaged={setSelectedGitFileStaged}
          setGitOutputLog={setGitOutputLog}
          onRefreshGit={onRefreshGit}
          onStageAll={onStageAll}
          onCommit={onCommit}
          onPull={onPull}
          onPush={onPush}
          onLoadDiff={onLoadDiff}
        />
      ) : (
        <div className="distillWorkspaceLayout">
          <div className="distillLeftCol">

          {distillTab === "paste" && (
            <div className="distillInputArea">
              <h3>Raw Input Context</h3>
              <textarea
                className="distillTextarea"
                value={distillInputText}
                onChange={(e) => setDistillInputText(e.target.value)}
                placeholder="Paste raw conversation logs, inbox captures, or meeting notes here to distill into structured wiki page proposed edits..."
              />
              <div className="distillActions">
                <button
                  type="button"
                  onClick={() => {
                    const mockPrompt = `<propose_edit type="create" path="Research/Compounding Memory.md">
  <reason>Documenting the core mechanism of LLM wiki maintenance.</reason>
  <content># Compounding Memory

Persistent synthesis allows LLMs to read and write directly to the wiki rather than searching raw chunks.
- **Persistent synthesis**: Continually updating a core wiki page.
- **LLM-editable Markdown**: Simple structure.
- **Maintenance loop**: Compounding knowledge over time.</content>
</propose_edit>

<propose_edit type="update" path="Home.md">
  <reason>Link the new Compounding Memory research note.</reason>
  <target_content>Welcome to the local wiki workspace!</target_content>
  <replacement_content>Welcome to the local wiki workspace! Explore the new [[Research/Compounding Memory]] note.</replacement_content>
</propose_edit>

<propose_edit type="delete" path="TempDraft.md">
  <reason>Clean up old draft note.</reason>
</propose_edit>

<propose_edit type="merge" path="StaleNotes.md" new_path="Home.md">
  <reason>Merge outdated stale notes into Home wiki page.</reason>
  <content>Welcome to the local wiki workspace! Explore the new [[Research/Compounding Memory]] note. Also merging relevant guidelines here.</content>
</propose_edit>`;
                    setDistillInputText(mockPrompt);
                  }}
                >
                  Load Mock Proposal
                </button>
                <button
                  className="primary"
                  type="button"
                  onClick={async () => {
                    const parsed = await vaultApi.parseProposedEdits(distillInputText);
                    const checkedParsed = parsed.map(p => ({ ...p, checked: true }));
                    setProposedEdits(checkedParsed);
                    setStatus(`Extracted ${checkedParsed.length} proposed edit(s).`);
                  }}
                >
                  Propose Wiki Edits
                </button>
              </div>
            </div>
          )}

          {distillTab === "chat" && (
            <div className="distillChatArea">
              <div className="chatHeader">
                <h3>LLM Copilot Chat</h3>
                <div className="chatHeaderActions">
                  <button
                    type="button"
                    className="textButton"
                    onClick={() => setShowLlmSettings(!showLlmSettings)}
                  >
                    ⚙️ {showLlmSettings ? "Close Settings" : "LLM Settings"}
                  </button>
                  <button
                    type="button"
                    className="textButton"
                    onClick={clearChatHistory}
                    disabled={chatMessages.length === 0}
                  >
                    🗑️ Clear Chat
                  </button>
                </div>
              </div>

              {showLlmSettings && (
                <LlmSettingsPanel
                  llmConfig={llmConfig}
                  setLlmConfig={setLlmConfig}
                  vaultConfig={vaultConfig}
                  updateVaultConfig={updateVaultConfig}
                  saveStoredLlmApiKey={saveStoredLlmApiKey}
                  readStoredLlmApiKey={readStoredLlmApiKey}
                  redactLlmConfig={redactLlmConfig}
                  pruneExpiredPromptRuns={pruneExpiredPromptRuns}
                  setShowLlmSettings={setShowLlmSettings}
                  setStatus={setStatus}
                />
              )}

              <div className="chatMessagesBox">
                {chatMessages.length === 0 ? (
                  <div className="chatEmptyState">
                    <p>Ask a question or request page edits using the wiki context.</p>
                    <p className="hint">Try asking: "Propose a new note summarizing the core features of React."</p>
                  </div>
                ) : (
                  chatMessages.map((msg, idx) => (
                    <div key={idx} className={`chatMessageBubble ${msg.role}`}>
                      <span className="messageSender">{msg.role === "user" ? "You" : "Copilot"}</span>
                      <div className="messageText">{msg.content}</div>
                    </div>
                  ))
                )}
                {isLlmGenerating && (
                  <div className="chatMessageBubble assistant generating">
                    <span className="messageSender">Copilot</span>
                    <div className="messageText">Thinking...</div>
                  </div>
                )}
              </div>

              <div className="chatInputControls">
                <div className="chatContextOption">
                  <label>
                    <input
                      type="checkbox"
                      checked={includeContext}
                      onChange={(e) => setIncludeContext(e.target.checked)}
                    />
                    Include active context bundle ({contextBundle ? `${contextBundle.notePaths.length} note(s)` : "None"})
                  </label>
                </div>
                <div className="chatInputRow">
                  <textarea
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleSendChatMessage();
                      }
                    }}
                    placeholder="Message LLM copilot... (Press Enter to send)"
                  />
                  <button
                    type="button"
                    className="primary"
                    disabled={!chatInput.trim() || isLlmGenerating}
                    onClick={() => void handleSendChatMessage()}
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
          )}
               {distillTab === "auditor" && (
            <div className="distillAuditorArea">
              <div className="auditorHeader" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                <h3>Wiki Auditor</h3>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    className="smallButton"
                    disabled={isScanningHealth || isScanningUnresolved}
                    onClick={() => {
                      void runUnresolvedLinksScan();
                      void onRunHealthAudit();
                    }}
                  >
                    {isScanningHealth || isScanningUnresolved ? "Scanning..." : "Re-Scan Vault"}
                  </button>
                </div>
              </div>

              <div className="auditorSubTabs" style={{ display: "flex", gap: "12px", borderBottom: "1px solid #e2e8f0", marginBottom: "16px", paddingBottom: "8px" }}>
                <button
                  type="button"
                  className={`subTabButton ${auditorSubTab === "health" ? "active" : ""}`}
                  style={{
                    background: "none",
                    border: "none",
                    borderBottom: auditorSubTab === "health" ? "2px solid #2563eb" : "2px solid transparent",
                    padding: "6px 12px",
                    fontWeight: 600,
                    fontSize: "13px",
                    cursor: "pointer",
                    color: auditorSubTab === "health" ? "#2563eb" : "#475569"
                  }}
                  onClick={() => setAuditorSubTab("health")}
                >
                  Wiki Health Scorecard
                </button>
                <button
                  type="button"
                  className={`subTabButton ${auditorSubTab === "links" ? "active" : ""}`}
                  style={{
                    background: "none",
                    border: "none",
                    borderBottom: auditorSubTab === "links" ? "2px solid #2563eb" : "2px solid transparent",
                    padding: "6px 12px",
                    fontWeight: 600,
                    fontSize: "13px",
                    cursor: "pointer",
                    color: auditorSubTab === "links" ? "#2563eb" : "#475569"
                  }}
                  onClick={() => setAuditorSubTab("links")}
                >
                  Dead Links Scanner
                </button>
              </div>

              {auditorSubTab === "health" && (
                <div className="healthScorecardSection">
                  {isScanningHealth ? (
                    <div className="auditorLoading">
                      <span className="spinner">⌛</span> Auditing vault health & quality metrics...
                    </div>
                  ) : (
                    <>
                      {(() => {
                        const averageScore = healthReports.length > 0
                          ? Math.round(healthReports.reduce((acc, r) => acc + r.score, 0) / healthReports.length)
                          : 100;
                        const unhealthyNotes = healthReports.filter(r => r.score < 100).length;

                        return (
                          <>
                            <div className="healthStatsContainer" style={{ display: "flex", gap: "16px", marginBottom: "20px" }}>
                              <div className="healthStatCard" style={{ flex: 1, padding: "16px", borderRadius: "8px", border: "1px solid #e2e8f0", backgroundColor: "#f8fafc", textAlign: "center" }}>
                                <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "4px" }}>Global Health Score</div>
                                <div style={{ fontSize: "32px", fontWeight: 800, color: averageScore >= 90 ? "#10b981" : averageScore >= 70 ? "#d97706" : "#dc2626" }}>
                                  {averageScore}%
                                </div>
                              </div>
                              <div className="healthStatCard" style={{ flex: 1, padding: "16px", borderRadius: "8px", border: "1px solid #e2e8f0", backgroundColor: "#f8fafc", textAlign: "center" }}>
                                <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "4px" }}>Notes Scanned</div>
                                <div style={{ fontSize: "32px", fontWeight: 800, color: "#1e293b" }}>
                                  {healthReports.length}
                                </div>
                              </div>
                              <div className="healthStatCard" style={{ flex: 1, padding: "16px", borderRadius: "8px", border: "1px solid #e2e8f0", backgroundColor: "#f8fafc", textAlign: "center" }}>
                                <div style={{ fontSize: "11px", color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "4px" }}>Issues Pending</div>
                                <div style={{ fontSize: "32px", fontWeight: 800, color: unhealthyNotes > 0 ? "#d97706" : "#10b981" }}>
                                  {unhealthyNotes}
                                </div>
                              </div>
                            </div>

                            <div className="healthReportsList" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                              {healthReports.length === 0 ? (
                                <div style={{ textAlign: "center", padding: "24px", color: "#64748b" }}>
                                  No notes found in this vault to audit.
                                </div>
                              ) : (
                                healthReports.map((report) => {
                                  const isExpanded = expandedNotes.has(report.path);
                                  return (
                                    <div key={report.path} className="healthReportCard" style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "14px", backgroundColor: "#ffffff" }}>
                                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                          <span style={{ fontWeight: 600, fontSize: "14px", color: "#0f172a" }}>{report.title}</span>
                                          <span style={{ fontSize: "11px", color: "#64748b", fontFamily: "monospace" }}>{report.path}</span>
                                        </div>
                                        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                                          <span style={{
                                            fontSize: "12px",
                                            fontWeight: 700,
                                            padding: "3px 10px",
                                            borderRadius: "12px",
                                            backgroundColor: report.score >= 90 ? "#ecfdf5" : report.score >= 70 ? "#fffbeb" : "#fef2f2",
                                            color: report.score >= 90 ? "#047857" : report.score >= 70 ? "#b45309" : "#b91c1c",
                                            border: `1px solid ${report.score >= 90 ? "#a7f3d0" : report.score >= 70 ? "#fde68a" : "#fca5a5"}`
                                          }}>
                                            {report.score}/100
                                          </span>
                                          <button
                                            type="button"
                                            className="smallButton"
                                            onClick={() => {
                                              const next = new Set(expandedNotes);
                                              if (next.has(report.path)) {
                                                next.delete(report.path);
                                              } else {
                                                next.add(report.path);
                                              }
                                              setExpandedNotes(next);
                                            }}
                                          >
                                            {isExpanded ? "Hide Details" : `Issues (${report.issues.length})`}
                                          </button>
                                        </div>
                                      </div>

                                      {isExpanded && (
                                        <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px dashed #e2e8f0" }}>
                                          {report.issues.length === 0 ? (
                                            <div style={{ fontSize: "12px", color: "#10b981", fontWeight: 600, marginBottom: "8px" }}>
                                              ✓ No quality issues detected for this note.
                                            </div>
                                          ) : (
                                            <ul style={{ margin: "0 0 14px 0", paddingLeft: "18px", fontSize: "12px", color: "#475569", lineHeight: "1.5" }}>
                                              {report.issues.map((issue, idx) => (
                                                <li key={idx} style={{ marginBottom: "6px" }}>{issue}</li>
                                              ))}
                                            </ul>
                                          )}

                                          <div style={{ display: "flex", gap: "8px" }}>
                                            {report.missingSummary && (
                                              <button
                                                type="button"
                                                className="smallButton primary"
                                                disabled={generatingSummaryPath === report.path}
                                                onClick={() => void handleGenerateSummary(report.path)}
                                              >
                                                {generatingSummaryPath === report.path ? "Generating..." : "Generate Summary"}
                                              </button>
                                            )}
                                            <button
                                              type="button"
                                              className="smallButton"
                                              onClick={() => void handleFindLinkSuggestions(report.path)}
                                            >
                                              Find Link Suggestions
                                            </button>
                                            <button
                                              type="button"
                                              className="smallButton"
                                              onClick={async () => {
                                                if (onSelectNote) {
                                                  await onSelectNote(report.path);
                                                }
                                              }}
                                            >
                                              Open Note
                                            </button>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })
                              )}
                            </div>
                          </>
                        );
                      })()}
                    </>
                  )}
                </div>
              )}

              {auditorSubTab === "links" && (
                <div className="unresolvedLinksSection">
                  {isScanningUnresolved && (
                    <div className="auditorLoading">
                      <span className="spinner">⌛</span> Scanning all vault notes for unresolved wiki links...
                    </div>
                  )}

                  {!isScanningUnresolved && (
                    <div className="unresolvedLinksList">
                      {unresolvedLinks.length === 0 ? (
                        <div className="auditorSuccessState">
                          <span className="successCheck">✓</span>
                          <p>All wiki links are resolved! No dead links found in the vault.</p>
                        </div>
                      ) : (
                        <>
                          <p className="hint" style={{ marginBottom: "12px" }}>
                            The following wiki links exist in note contents but do not resolve to any existing note file. Select links to draft and resolve stubs in bulk.
                          </p>

                          <div className="bulkActionsBar">
                            <label className="checkboxLabel">
                              <input
                                type="checkbox"
                                checked={unresolvedLinks.length > 0 && selectedUnresolvedTargets.size === unresolvedLinks.length}
                                onChange={handleSelectAllToggle}
                                disabled={isBulkProcessing}
                              />
                              <span>Select All ({selectedUnresolvedTargets.size} / {unresolvedLinks.length})</span>
                            </label>
                            <div className="bulkActionButtons">
                              <button
                                type="button"
                                className="smallButton primary"
                                disabled={selectedUnresolvedTargets.size === 0 || isBulkProcessing}
                                onClick={() => void runBulkDrafting()}
                              >
                                {isBulkProcessing ? "Drafting..." : `Draft Selected (${selectedUnresolvedTargets.size})`}
                              </button>
                              <button
                                type="button"
                                className="smallButton successButton"
                                disabled={
                                  isBulkProcessing ||
                                  approvedCount === 0
                                }
                                onClick={() => void createSelectedStubs()}
                              >
                                Create Approved ({approvedCount})
                              </button>
                              {hasDoneDrafts && (
                                <>
                                  <button
                                    type="button"
                                    className="smallButton"
                                    disabled={isBulkProcessing}
                                    onClick={approveAllDrafts}
                                  >
                                    Approve All
                                  </button>
                                  <button
                                    type="button"
                                    className="smallButton"
                                    disabled={isBulkProcessing}
                                    onClick={rejectAllDrafts}
                                  >
                                    Reject All
                                  </button>
                                </>
                              )}
                              {Object.keys(bulkDrafts).length > 0 && (
                                <button
                                  type="button"
                                  className="smallButton"
                                  disabled={isBulkProcessing}
                                  onClick={() => {
                                    setBulkDrafts({});
                                    setSelectedUnresolvedTargets(new Set());
                                  }}
                                >
                                  Clear Drafts
                                </button>
                              )}
                            </div>
                          </div>

                          {unresolvedLinks.map((item) => {
                            const draftState = bulkDrafts[item.target];
                            const isRejected = draftState?.status === "done" && draftState.approved === false;
                            return (
                              <div key={item.target} className={`unresolvedLinkCard ${isRejected ? "rejected" : ""}`}>
                                <div className="unresolvedLinkHeader">
                                  <label className="checkboxLabel">
                                    <input
                                      type="checkbox"
                                      checked={selectedUnresolvedTargets.has(item.target)}
                                      onChange={(e) => {
                                        const next = new Set(selectedUnresolvedTargets);
                                        if (e.target.checked) {
                                          next.add(item.target);
                                        } else {
                                          next.delete(item.target);
                                        }
                                        setSelectedUnresolvedTargets(next);
                                      }}
                                      disabled={isBulkProcessing}
                                    />
                                    <strong>[[{item.target}]]</strong>
                                  </label>

                                  <div className="cardHeaderActions" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                    {draftState?.status === "drafting" && <span className="statusText drafting">⌛ Drafting...</span>}
                                    {draftState?.status === "done" && (
                                      <>
                                        {draftState.approved ? (
                                          <>
                                            <span className="reviewBadge approved">✓ Approved</span>
                                            <button
                                              type="button"
                                              className="smallButton"
                                              style={{ background: "#fee2e2", borderColor: "#fecaca", color: "#991b1b" }}
                                              disabled={isBulkProcessing}
                                              onClick={() => rejectDraft(item.target)}
                                            >
                                              Reject
                                            </button>
                                          </>
                                        ) : (
                                          <>
                                            <span className="reviewBadge rejected">✗ Rejected</span>
                                            <button
                                              type="button"
                                              className="smallButton primary"
                                              disabled={isBulkProcessing}
                                              onClick={() => approveDraft(item.target)}
                                            >
                                              Approve
                                            </button>
                                          </>
                                        )}
                                      </>
                                    )}
                                    {draftState?.status === "error" && <span className="statusText error">❌ Failed</span>}

                                    {!draftState && (
                                      <button
                                        type="button"
                                        className="smallButton primary"
                                        disabled={isBulkProcessing}
                                        onClick={() => void draftStubNote(item.target, item.sources)}
                                      >
                                        Draft Stub
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {draftState?.status === "done" && (
                                  <div className="cardDraftPreview">
                                    <textarea
                                      className="stubPreviewTextarea"
                                      value={draftState.content}
                                      disabled={!draftState.approved}
                                      onChange={(e) => {
                                        setBulkDrafts(prev => ({
                                          ...prev,
                                          [item.target]: { ...prev[item.target], content: e.target.value }
                                        }));
                                      }}
                                      placeholder="Edit drafted stub content..."
                                    />
                                  </div>
                                )}

                                <div className="unresolvedLinkSources">
                                  <span>Referenced in:</span>
                                  {item.sources.map((source) => (
                                    <div key={source.path} className="sourceExcerptCard">
                                      <div className="sourceTitle">
                                        {source.title} (<code>{source.path}</code>)
                                      </div>
                                      <pre className="sourceExcerpt">{source.excerpt}</pre>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="distillRightCol">
          <div className="proposedEditsHeader">
            <h3>Proposed Edits ({proposedEdits.filter(p => !p.applied).length} pending)</h3>
            <button
              className="primary"
              disabled={proposedEdits.filter(p => p.checked && !p.applied).length === 0}
              onClick={() => void applyCheckedEdits()}
            >
              Apply Checked Edits
            </button>
          </div>

          {proposedEdits.length === 0 ? (
            <div className="noProposalsBox">
              <span style={{ color: "#64748b" }}>No proposed edits extracted yet. Paste context and click "Propose Wiki Edits".</span>
            </div>
          ) : (
            <div className="proposalsList">
              {proposedEdits.map((edit) => (
                <div
                  key={edit.id}
                  className={`proposalCard ${edit.applied ? "applied" : ""}`}
                >
                  <div className="proposalCardHeader">
                    <label className="proposalCheckboxLabel">
                      <input
                        type="checkbox"
                        checked={!!edit.checked}
                        disabled={edit.applied}
                        onChange={(e) => {
                          setProposedEdits(prev =>
                            prev.map(p => p.id === edit.id ? { ...p, checked: e.target.checked } : p)
                          );
                        }}
                      />
                      <span className="proposalPath">{edit.path}</span>
                    </label>
                    <span className={`proposalBadge ${edit.type}`}>{edit.type}</span>
                    {edit.applied && <span className="appliedBadge">✓ Applied</span>}
                  </div>

                  {edit.reason && (
                    <div className="proposalReason">
                      <strong>Reason:</strong> {edit.reason}
                    </div>
                  )}

                  <div className="proposalBody">
                    {edit.type === "create" && (
                      <div className="proposalEditor">
                        <label>Proposed Content:</label>
                        <textarea
                          className="proposalTextarea"
                          value={edit.content || ""}
                          disabled={edit.applied}
                          onChange={(e) => {
                            setProposedEdits(prev =>
                              prev.map(p => p.id === edit.id ? { ...p, content: e.target.value } : p)
                            );
                          }}
                        />
                      </div>
                    )}

                    {edit.type === "update" && (
                      <div className="proposalDiffView">
                        <div className="diffOriginal">
                          <span className="diffLabel">Target Segment (Search):</span>
                          <pre>{edit.targetContent}</pre>
                        </div>
                        <div className="diffReplacement">
                          <span className="diffLabel">Replacement Segment:</span>
                          <div className="proposalEditor">
                            <textarea
                              className="proposalTextarea"
                              value={edit.replacementContent || ""}
                              disabled={edit.applied}
                              onChange={(e) => {
                                setProposedEdits(prev =>
                                  prev.map(p => p.id === edit.id ? { ...p, replacementContent: e.target.value } : p)
                                );
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {edit.type === "delete" && (
                      <div className="proposalDeleteNotice">
                        This action will delete the note at <strong>{edit.path}</strong>.
                      </div>
                    )}

                    {edit.type === "merge" && (
                      <div className="proposalMergeFields">
                        <div>
                          <strong>Target Destination:</strong> <code className="proposalPath">{edit.newPath}</code>
                        </div>
                        <div className="proposalEditor" style={{ marginTop: 8 }}>
                          <label>Merged Content:</label>
                          <textarea
                            className="proposalTextarea"
                            value={edit.content || ""}
                            disabled={edit.applied}
                            onChange={(e) => {
                              setProposedEdits(prev =>
                                prev.map(p => p.id === edit.id ? { ...p, content: e.target.value } : p)
                              );
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      )}
    </section>
  );
}
