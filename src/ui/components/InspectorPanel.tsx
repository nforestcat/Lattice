import type { VaultSnapshot, VaultConfig, ContextBundle, ContextBundleCandidate } from "../../api/types";

export interface InspectorPanelProps {
  vault: VaultSnapshot | null;
  activePath: string | null;
  draft: string;
  selectedContextCount: number;
  selectedContextCharacters: number;
  selectedContextTokens: number;
  contextLimit: number;
  isCustomLimit: boolean;
  setIsCustomLimit: (custom: boolean) => void;
  handleLimitChange: (limit: number) => void;
  bundlePreset: string;
  handlePresetChange: (preset: string) => void;
  setBundlePreset: (preset: any) => void;
  PRESETS: Record<string, { label: string; purpose: string; mode: "short" | "standard" | "full" }>;
  bundlePurpose: string;
  setBundlePurpose: (purpose: string) => void;
  bundleMode: "short" | "standard" | "full";
  setBundleMode: (mode: "short" | "standard" | "full") => void;
  updateVaultConfig: (updates: Partial<VaultConfig>) => Promise<void>;
  setContextBundle: (bundle: ContextBundle | null) => void;
  displayedCandidates: ContextBundleCandidate[];
  embeddingStatus: string;
  sortBy: "score" | "title" | "reason";
  setSortBy: (sort: "score" | "title" | "reason") => void;
  filterBy: string;
  setFilterBy: (filter: string) => void;
  selectedContextPaths: Set<string>;
  toggleContextCandidate: (path: string) => void;
  autoPruneCandidates: () => Promise<void>;
  switchToShortMode: () => Promise<void>;
  generateContextBundle: () => Promise<void>;
  contextBundle: ContextBundle | null;
  prevContextBundle: ContextBundle | null;
  contextCandidates: ContextBundleCandidate[];
  showTemplates: boolean;
  setShowTemplates: (show: boolean) => void;
  promptInstruction: string;
  handlePromptInstructionChange: (val: string) => void;
  BUILTIN_TEMPLATES: Array<{ id: string; name: string; template: string }>;
  vaultConfig: VaultConfig;
  compileTemplate: (tmpl: string) => string;
  deleteTemplate: (id: string, e: React.MouseEvent) => Promise<void>;
  saveAsTemplate: () => Promise<void>;
  copyCombinedPrompt: () => Promise<void>;
  copyContextBundle: () => Promise<void>;
  presetForSettings: (purpose: string, mode: "short" | "standard" | "full") => any;
  normalizeBundleMode: (val: string, fallback: "short" | "standard" | "full") => "short" | "standard" | "full";
}

export function InspectorPanel({
  vault,
  activePath,
  draft,
  selectedContextCount,
  selectedContextCharacters,
  selectedContextTokens,
  contextLimit,
  isCustomLimit,
  setIsCustomLimit,
  handleLimitChange,
  bundlePreset,
  handlePresetChange,
  setBundlePreset,
  PRESETS,
  bundlePurpose,
  setBundlePurpose,
  bundleMode,
  setBundleMode,
  updateVaultConfig,
  setContextBundle,
  displayedCandidates,
  embeddingStatus,
  sortBy,
  setSortBy,
  filterBy,
  setFilterBy,
  selectedContextPaths,
  toggleContextCandidate,
  autoPruneCandidates,
  switchToShortMode,
  generateContextBundle,
  contextBundle,
  prevContextBundle,
  contextCandidates,
  showTemplates,
  setShowTemplates,
  promptInstruction,
  handlePromptInstructionChange,
  BUILTIN_TEMPLATES,
  vaultConfig,
  compileTemplate,
  deleteTemplate,
  saveAsTemplate,
  copyCombinedPrompt,
  copyContextBundle,
  presetForSettings,
  normalizeBundleMode,
}: InspectorPanelProps) {
  return (
    <section>
      <h2>LLM Context</h2>
      <div className="bundleSummary">
        <span>{selectedContextCount}/{contextCandidates.length} notes</span>
        <span>{selectedContextCharacters} chars</span>
      </div>

      <div className="budgetSection">
        <div className="budgetsHeader">
          <span>{selectedContextTokens.toLocaleString()} / {contextLimit.toLocaleString()} tokens</span>
          <span className="budgetPercent">{Math.min(100, Math.round((selectedContextTokens / (contextLimit || 1)) * 100))}%</span>
        </div>

        <div className="progressBarOuter">
          <div
            className={`progressBarInner ${selectedContextTokens > contextLimit ? "overLimit" : ""}`}
            style={{ width: `${Math.min(100, (selectedContextTokens / (contextLimit || 1)) * 100)}%` }}
          />
        </div>

        {selectedContextTokens > contextLimit && (
          <div className="budgetWarning">
            <p style={{ margin: 0, marginBottom: "8px" }}>
              ⚠️ Exceeded target limit by {(selectedContextTokens - contextLimit).toLocaleString()} tokens.
            </p>
            <div className="warningActions">
              {contextCandidates.some((c) => selectedContextPaths.has(c.path) && c.reason === "Recommended") && (
                <button className="warningButton" onClick={() => void autoPruneCandidates()}>
                  Auto-prune Recommended
                </button>
              )}
              {bundleMode !== "short" && (
                <button className="warningButton" onClick={() => void switchToShortMode()}>
                  Switch to Short Mode
                </button>
              )}
            </div>
          </div>
        )}

        <div className="limitConfig">
          <label htmlFor="context-limit-select">Limit</label>
          <div className="limitInputs">
            <select
              id="context-limit-select"
              value={isCustomLimit ? "custom" : contextLimit}
              onChange={(event) => {
                const val = event.target.value;
                if (val === "custom") {
                  setIsCustomLimit(true);
                } else {
                  setIsCustomLimit(false);
                  handleLimitChange(parseInt(val, 10));
                }
              }}
            >
              <option value={8000}>Small - 8K</option>
              <option value={32000}>Medium - 32K</option>
              <option value={128000}>Large - 128K</option>
              <option value={200000}>Huge - 200K</option>
              <option value="custom">Custom...</option>
            </select>

            {isCustomLimit && (
              <input
                type="number"
                className="customLimitField"
                placeholder="Tokens..."
                value={contextLimit}
                onChange={(event) => {
                  const val = parseInt(event.target.value, 10);
                  handleLimitChange(isNaN(val) ? 0 : val);
                }}
              />
            )}
          </div>
        </div>
      </div>

      <div className="bundleOptions">
        <div className="optionGroup">
          <label htmlFor="bundle-preset">Preset</label>
          <select
            id="bundle-preset"
            value={bundlePreset}
            onChange={(event) => handlePresetChange(event.target.value)}
          >
            {Object.entries(PRESETS).map(([key, config]) => (
              <option key={key} value={key}>
                {config.label}
              </option>
            ))}
          </select>
        </div>
        <div className="optionGroup">
          <label htmlFor="bundle-purpose">Purpose</label>
          <input
            id="bundle-purpose"
            type="text"
            placeholder="e.g. Summarize or refactor..."
            value={bundlePurpose}
            onChange={(event) => {
              const val = event.target.value;
              const nextPreset = presetForSettings(val, bundleMode);
              setBundlePurpose(val);
              setBundlePreset(nextPreset);
              void updateVaultConfig({ bundlePurpose: val, bundlePreset: nextPreset });
              setContextBundle(null);
            }}
          />
        </div>
        <div className="optionGroup">
          <label htmlFor="bundle-mode">Mode</label>
          <select
            id="bundle-mode"
            value={bundleMode}
            onChange={(event) => {
              const val = normalizeBundleMode(event.target.value, bundleMode);
              const nextPreset = presetForSettings(bundlePurpose, val);
              setBundleMode(val);
              setBundlePreset(nextPreset);
              void updateVaultConfig({ bundleMode: val, bundlePreset: nextPreset });
              setContextBundle(null);
            }}
          >
            <option value="short">Short (Excerpt)</option>
            <option value="standard">Standard (Full)</option>
            <option value="full">Full (Full + Links)</option>
          </select>
        </div>
      </div>
      <div className="candidatesSectionHeader">
        <h3>
          Related Candidates ({displayedCandidates.length})
          {embeddingStatus && <span className="embeddingStatusText"> ({embeddingStatus})</span>}
        </h3>
        <div className="candidatesFilterControls">
          <div className="filterGroup">
            <label htmlFor="candidates-sort">Sort</label>
            <select
              id="candidates-sort"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
            >
              <option value="score">Score</option>
              <option value="title">Title</option>
              <option value="reason">Reason</option>
            </select>
          </div>
          <div className="filterGroup">
            <label htmlFor="candidates-filter">Filter</label>
            <select
              id="candidates-filter"
              value={filterBy}
              onChange={(e) => setFilterBy(e.target.value)}
            >
              <option value="all">All</option>
              <option value="selected">Selected</option>
              <option value="focus">Focus</option>
              <option value="outgoing">Outgoing</option>
              <option value="backlink">Backlink</option>
              <option value="recommended">Recommended</option>
            </select>
          </div>
        </div>
      </div>
      <div className="candidateList">
        {displayedCandidates.map((candidate) => {
          const scoreColorClass = 
            candidate.score >= 9.0 ? "score-high" :
            candidate.score >= 7.0 ? "score-medium" : "score-low";
          const reasonClass = `reason-badge reason-${candidate.reason.toLowerCase()}`;

          return (
            <div key={candidate.path} className="candidateRow">
              <div className="candidateTop">
                <label className="candidateLabel">
                  <input
                    type="checkbox"
                    checked={selectedContextPaths.has(candidate.path)}
                    onChange={() => toggleContextCandidate(candidate.path)}
                  />
                  <strong>{candidate.title}</strong>
                </label>
                <div className="candidateBadges">
                  <span className={reasonClass}>{candidate.reason}</span>
                  <span className={`score-badge ${scoreColorClass}`}>{candidate.score.toFixed(1)}</span>
                </div>
              </div>
              <div className="candidateDetails">
                <p className="reasonDetail">{candidate.reasonDetail}</p>
                {candidate.excerpt && <p className="candidateExcerpt">{candidate.excerpt}</p>}
                <span className="candidateMeta">{candidate.characterCount} chars · ~{candidate.tokenEstimate.toLocaleString()} tokens · {candidate.path}</span>
              </div>
            </div>
          );
        })}
      </div>
      <button onClick={() => void generateContextBundle()} disabled={!activePath || selectedContextCount === 0}>Generate bundle</button>
      {contextBundle && (
        <div className="bundleBox">
          <p className="muted">
            {contextBundle.notePaths.length} notes · {contextBundle.markdown.length} chars · ~{contextBundle.estimatedTokens.toLocaleString()} tokens
          </p>
          {contextBundle.estimatedTokens > contextLimit && (
            <div className="budgetWarning" style={{ marginBottom: "8px" }}>
              <p style={{ margin: 0, marginBottom: "8px" }}>
                ⚠️ Generated bundle exceeds target limit by {(contextBundle.estimatedTokens - contextLimit).toLocaleString()} tokens.
              </p>
              <div className="warningActions">
                {contextCandidates.some((c) => selectedContextPaths.has(c.path) && c.reason === "Recommended") && (
                  <button className="warningButton" onClick={() => void autoPruneCandidates()}>
                    Auto-prune & Regenerate
                  </button>
                )}
                {bundleMode !== "short" && (
                  <button className="warningButton" onClick={() => void switchToShortMode()}>
                    Switch to Short Mode
                  </button>
                )}
              </div>
            </div>
          )}
          <details className="bundleAuditDetails">
            <summary>🔍 Context Bundle Audit & Diff</summary>
            <div className="bundleAuditContent">
              {prevContextBundle && (
                <div className="bundleDiffSection">
                  <h4>Changes from Previous Bundle</h4>
                  <div className="bundleDiffMetrics">
                    <span className={`tokenDeltaBadge ${contextBundle.estimatedTokens - prevContextBundle.estimatedTokens > 0 ? "positive" : contextBundle.estimatedTokens - prevContextBundle.estimatedTokens < 0 ? "negative" : "zero"}`}>
                      {contextBundle.estimatedTokens - prevContextBundle.estimatedTokens > 0 ? `+${(contextBundle.estimatedTokens - prevContextBundle.estimatedTokens).toLocaleString()}` : (contextBundle.estimatedTokens - prevContextBundle.estimatedTokens).toLocaleString()} tokens
                    </span>
                    {contextBundle.notePaths.filter(p => !new Set(prevContextBundle.notePaths).has(p)).length === 0 &&
                     prevContextBundle.notePaths.filter(p => !new Set(contextBundle.notePaths).has(p)).length === 0 && (
                      <span className="muted italic" style={{ marginLeft: "8px" }}>No note list changes</span>
                    )}
                  </div>
                  
                  {contextBundle.notePaths.filter(p => !new Set(prevContextBundle.notePaths).has(p)).length > 0 && (
                    <div className="diffGroup">
                      <span className="diffLabel added">Added ({contextBundle.notePaths.filter(p => !new Set(prevContextBundle.notePaths).has(p)).length}):</span>
                      <div className="diffNotesList">
                        {contextBundle.notePaths.filter(p => !new Set(prevContextBundle.notePaths).has(p)).map(p => (
                          <span key={p} className="diffNoteName added">+{p.split('/').pop() || p}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {prevContextBundle.notePaths.filter(p => !new Set(contextBundle.notePaths).has(p)).length > 0 && (
                    <div className="diffGroup">
                      <span className="diffLabel removed">Removed ({prevContextBundle.notePaths.filter(p => !new Set(contextBundle.notePaths).has(p)).length}):</span>
                      <div className="diffNotesList">
                        {prevContextBundle.notePaths.filter(p => !new Set(contextBundle.notePaths).has(p)).map(p => (
                          <span key={p} className="diffNoteName removed">-{p.split('/').pop() || p}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="bundleBreakdownSection">
                <h4>Included Notes Breakdown</h4>
                <div className="auditBreakdownList">
                  {contextBundle.notePaths.map(path => {
                    const isFocus = path === activePath;
                    const cand = contextCandidates.find(c => c.path === path);
                    const title = cand?.title || path.split('/').pop() || path;
                    const reason = isFocus ? "Focus" : (cand?.reason || "Linked");
                    const reasonDetail = isFocus ? "This is the active note of your workspace." : (cand?.reasonDetail || "Referenced note");
                    
                    // Quality flags calculation
                    const characterCount = isFocus ? draft.length : (cand?.characterCount || 0);
                    const isTooLarge = characterCount > 10000 || (cand ? cand.tokenEstimate > 2500 : false);
                    
                    const noteMeta = vault?.notes.find(n => n.path === path);
                    const modifiedAtStr = noteMeta?.modifiedAt;
                    let isStale = false;
                    if (modifiedAtStr) {
                      const modifiedDate = new Date(modifiedAtStr);
                      const diffTime = Date.now() - modifiedDate.getTime();
                      const diffDays = diffTime / (1000 * 60 * 60 * 24);
                      isStale = diffDays > 30;
                    }
                    
                    const isUseful = isFocus || reason === "Outgoing" || reason === "Backlink" || (cand ? cand.score >= 7.5 : false);
                    const isRedundant = cand ? (cand.reason === "Recommended" && cand.score < 5.0) : false;
                    
                    const qualityBadges: { type: string; label: string }[] = [];
                    if (isUseful) qualityBadges.push({ type: "useful", label: "Useful" });
                    if (isRedundant) qualityBadges.push({ type: "redundant", label: "Redundant" });
                    if (isTooLarge) qualityBadges.push({ type: "large", label: "Too Large" });
                    if (isStale) qualityBadges.push({ type: "stale", label: "Stale" });
                    
                    return (
                      <div key={path} className="auditNoteRow">
                        <div className="auditNoteHeader">
                          <span className="auditNoteTitle" title={path}>{title}</span>
                          <span className={`reason-badge reason-${reason.toLowerCase()}`}>{reason}</span>
                        </div>
                        <div className="auditNoteDetail">{reasonDetail}</div>
                        {qualityBadges.length > 0 && (
                          <div className="qualityBadges">
                            {qualityBadges.map(badge => (
                              <span key={badge.type} className={`qualityBadge ${badge.type}`}>
                                {badge.label}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </details>

          <div className="promptWorkspace">
            <h3>Prompt Workspace</h3>
            <div className="optionGroup" style={{ marginTop: "4px" }}>
              <div className="promptWorkspaceHeader">
                <label htmlFor="prompt-instruction">Question / Instructions</label>
                <div className="templateSelectorContainer">
                  <button 
                    className="smallButton" 
                    onClick={() => setShowTemplates(!showTemplates)}
                    style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
                  >
                    Templates ▾
                  </button>
                  <button 
                    className="smallButton" 
                    onClick={() => void saveAsTemplate()} 
                    disabled={!promptInstruction.trim()}
                    title="Save current instructions as template"
                  >
                    Save as Template
                  </button>

                  {showTemplates && (
                    <div className="templatesDropdownMenu">
                      <div className="templatesDropdownHeader">System Templates</div>
                      {BUILTIN_TEMPLATES.map((tmpl) => (
                        <div 
                          key={tmpl.id} 
                          className="templatesDropdownItem"
                          onClick={() => {
                            handlePromptInstructionChange(compileTemplate(tmpl.template));
                            setShowTemplates(false);
                          }}
                        >
                          <span>{tmpl.name}</span>
                        </div>
                      ))}
                      {vaultConfig.promptTemplates && vaultConfig.promptTemplates.length > 0 && (
                        <>
                          <div className="templatesDropdownHeader">Custom Templates</div>
                          {vaultConfig.promptTemplates.map((tmpl) => (
                            <div 
                              key={tmpl.id} 
                              className="templatesDropdownItem customTemplateItem"
                              onClick={() => {
                                handlePromptInstructionChange(compileTemplate(tmpl.template));
                                setShowTemplates(false);
                              }}
                            >
                              <span>{tmpl.name}</span>
                              <button 
                                className="deleteTemplateBtn"
                                onClick={(e) => void deleteTemplate(tmpl.id, e)}
                                title="Delete custom template"
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <textarea
                id="prompt-instruction"
                placeholder="Ask a question or specify the task for the LLM..."
                value={promptInstruction}
                onChange={(e) => handlePromptInstructionChange(e.target.value)}
                style={{ minHeight: "80px" }}
              />
            </div>
            <div className="workspaceActions">
              <button className="primary" onClick={() => void copyCombinedPrompt()}>
                Copy Final Prompt
              </button>
              <button onClick={() => void copyContextBundle()}>
                Copy Bundle Only
              </button>
            </div>
          </div>
          <textarea readOnly value={contextBundle.markdown} />
        </div>
      )}
    </section>
  );
}
