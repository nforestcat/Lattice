import type { VaultSnapshot, LlmConfig, LlmProvider, VaultConfig, ContextBundle, ProposedEdit, UnresolvedLinkGroup } from "../../api/types";
import type { ChatMessage } from "../../api/llm";
import { vaultApi } from "../../api";
import { LlmSettingsPanel } from "./LlmSettingsPanel";

interface DistillWorkspaceProps {
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

  distillTab: "paste" | "chat" | "auditor";
  setDistillTab: (tab: "paste" | "chat" | "auditor") => void;
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
  bulkDrafts: Record<string, { content: string; status: "done" | "drafting" | "error" }>;
  setBulkDrafts: React.Dispatch<React.SetStateAction<Record<string, { content: string; status: "done" | "drafting" | "error" }>>>;
  isBulkProcessing: boolean;
  runUnresolvedLinksScan: () => Promise<void>;
  handleSelectAllToggle: (e: React.ChangeEvent<HTMLInputElement>) => void;
  runBulkDrafting: () => Promise<void>;
  createSelectedStubs: () => Promise<void>;
  draftStubNote: (target: string, sources: Array<{ path: string; title: string; excerpt: string }>) => Promise<void>;
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
}: DistillWorkspaceProps) {
  return (
    <section className="distillSurface">
      <div className="distillWorkspaceLayout">
        <div className="distillLeftCol">
          <div className="distillTabHeader">
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
              }}
            >
              Wiki Auditor
            </button>
          </div>

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
              <div className="auditorHeader">
                <h3>Wiki Link Auditor</h3>
                <button
                  type="button"
                  className="smallButton"
                  disabled={isScanningUnresolved}
                  onClick={() => void runUnresolvedLinksScan()}
                >
                  {isScanningUnresolved ? "Scanning..." : "Re-Scan Vault"}
                </button>
              </div>

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
                              selectedUnresolvedTargets.size === 0 ||
                              isBulkProcessing ||
                              Array.from(selectedUnresolvedTargets).filter(t => bulkDrafts[t]?.status === "done").length === 0
                            }
                            onClick={() => void createSelectedStubs()}
                          >
                            Create Selected
                          </button>
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
                        return (
                          <div key={item.target} className="unresolvedLinkCard">
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

                              <div className="cardHeaderActions">
                                {draftState?.status === "drafting" && <span className="statusText drafting">⌛ Drafting...</span>}
                                {draftState?.status === "done" && <span className="statusText success">✓ Draft Ready</span>}
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
    </section>
  );
}
