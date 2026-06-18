import { useMemo } from "react";
import type { NoteContext, BacklinkSuggestion, ContextBundleCandidate } from "../../api/types";

interface SemanticRecommendation {
  path: string;
  title: string;
  score: number; // Normalized to 0..100
  source: "embeddings" | "contextCandidates";
  detail: string;
  excerpt?: string;
  rawSuggestion?: BacklinkSuggestion;
}

interface LinkSuggestionsSidebarProps {
  activePath: string | null;
  context: NoteContext | null;
  linkSuggestions: Array<{ text: string; path: string }>;
  backlinkSuggestions: BacklinkSuggestion[];
  contextCandidates: ContextBundleCandidate[];
  isLoadingBacklinks: boolean;
  onNavigateNote: (path: string) => Promise<void>;
  onInsertLinkAtCursor: (title: string) => void;
  onApplyWikiLinkSuggestion: (title: string) => void;
  onApplyBacklinkSuggestion: (suggestion: BacklinkSuggestion) => Promise<boolean>;
}

export function LinkSuggestionsSidebar({
  activePath,
  context,
  linkSuggestions,
  backlinkSuggestions,
  contextCandidates,
  isLoadingBacklinks,
  onNavigateNote,
  onInsertLinkAtCursor,
  onApplyWikiLinkSuggestion,
  onApplyBacklinkSuggestion,
}: LinkSuggestionsSidebarProps) {
  // 1. Outgoing Links
  const outgoingLinks = context?.outgoingLinks || [];

  // 2. Backlinks
  const backlinks = context?.backlinks || [];

  // 3. Unlinked Mentions
  // Mentions in this note (linkSuggestions)
  const mentionsInThisNote = linkSuggestions || [];
  // Mentions of this note in other notes (backlinkSuggestions with type "unlinked_mention")
  const mentionsInOtherNotes = backlinkSuggestions.filter(
    (s) => s.suggestionType === "unlinked_mention"
  );

  // 4. Semantic Recommendations
  // We need to merge and deduplicate semantic recommendations from:
  // - backlinkSuggestions of type "semantic" (score is 0..1)
  // - contextCandidates of type "Recommended" (score is 0..10)
  // Deduplicate by path. If a path is already linked as outgoing or backlink, skip it!
  const semanticRecommendations = useMemo(() => {
    const linkedPaths = new Set([
      ...outgoingLinks.map((l) => l.resolvedPath).filter(Boolean),
      ...backlinks.map((l) => l.sourcePath),
    ]);

    const semanticMap = new Map<string, SemanticRecommendation>();

    // Add from backlinkSuggestions
    backlinkSuggestions
      .filter((s) => s.suggestionType === "semantic")
      .forEach((s) => {
        const path = s.sourcePath;
        if (linkedPaths.has(path)) return;
        const scorePercent = Math.round(s.score * 100);
        semanticMap.set(path, {
          path,
          title: s.sourceTitle,
          score: scorePercent,
          source: "embeddings",
          detail: `Vector similarity: ${scorePercent}% match`,
          excerpt: s.excerpt || undefined,
          rawSuggestion: s,
        });
      });

    // Add from contextCandidates
    contextCandidates
      .filter((c) => c.reason === "Recommended")
      .forEach((c) => {
        const path = c.path;
        if (linkedPaths.has(path)) return;
        const scorePercent = Math.round(c.score * 10);
        const existing = semanticMap.get(path);
        if (!existing || scorePercent > existing.score) {
          semanticMap.set(path, {
            path,
            title: c.title,
            score: scorePercent,
            source: "contextCandidates",
            detail: c.reasonDetail,
            excerpt: c.excerpt || undefined,
            rawSuggestion: existing?.rawSuggestion,
          });
        }
      });

    return Array.from(semanticMap.values()).sort((a, b) => b.score - a.score);
  }, [outgoingLinks, backlinks, backlinkSuggestions, contextCandidates]);

  // If no note is active, show empty state
  if (!activePath) {
    return (
      <div className="linkSuggestionsSidebar emptyState">
        <p className="muted">Select a note from the file tree to see link suggestions.</p>
      </div>
    );
  }

  return (
    <div className="linkSuggestionsSidebar">
      {/* Outgoing Links Section */}
      <section className="suggestionsSection">
        <h4>Outgoing Links ({outgoingLinks.length})</h4>
        {outgoingLinks.length === 0 ? (
          <div className="suggestionsEmptyState">No outgoing links in this note.</div>
        ) : (
          <div className="suggestionsList">
            {outgoingLinks.map((link, idx) => (
              <div key={`outgoing-${link.targetRef}-${idx}`} className="suggestionItem">
                <div className="suggestionItemRow">
                  <span className="suggestionItemName">{link.targetRef}</span>
                  <div className="suggestionItemActions">
                    <button
                      type="button"
                      className="suggestionActionBtn"
                      title="Insert wiki link at cursor"
                      onClick={() => onInsertLinkAtCursor(link.targetRef)}
                    >
                      Insert
                    </button>
                    {link.resolvedPath && (
                      <button
                        type="button"
                        className="suggestionActionBtn"
                        title="View note"
                        onClick={() => void onNavigateNote(link.resolvedPath!)}
                      >
                        View
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Backlinks Section */}
      <section className="suggestionsSection">
        <h4>Backlinks ({backlinks.length})</h4>
        {backlinks.length === 0 ? (
          <div className="suggestionsEmptyState">No backlinks to this note.</div>
        ) : (
          <div className="suggestionsList">
            {backlinks.map((link, idx) => {
              const filename = link.sourcePath.split("/").pop() || link.sourcePath;
              const title = filename.replace(/\.md$/, "");
              return (
                <div key={`backlink-${link.sourcePath}-${idx}`} className="suggestionItem">
                  <div className="suggestionItemRow">
                    <span className="suggestionItemName">{title}</span>
                    <div className="suggestionItemActions">
                      <button
                        type="button"
                        className="suggestionActionBtn"
                        title="Insert wiki link at cursor"
                        onClick={() => onInsertLinkAtCursor(title)}
                      >
                        Insert
                      </button>
                      <button
                        type="button"
                        className="suggestionActionBtn"
                        title="View note"
                        onClick={() => void onNavigateNote(link.sourcePath)}
                      >
                        View
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Unlinked Mentions section */}
      <section className="suggestionsSection">
        <h4>Unlinked Mentions</h4>

        {/* Mentions in this Note */}
        <div className="mentionsSubsection" style={{ marginBottom: "12px" }}>
          <h5>In this Note ({mentionsInThisNote.length})</h5>
          {mentionsInThisNote.length === 0 ? (
            <div className="suggestionsEmptyState">No unlinked mentions found in this note.</div>
          ) : (
            <div className="suggestionsList">
              {mentionsInThisNote.map((mention, idx) => (
                <div key={`mention-in-${mention.text}-${idx}`} className="suggestionItem">
                  <div className="suggestionItemRow">
                    <span className="suggestionItemName">{mention.text}</span>
                    <div className="suggestionItemActions">
                      <button
                        type="button"
                        className="suggestionActionBtn"
                        title="Insert wiki link at cursor"
                        onClick={() => onInsertLinkAtCursor(mention.text)}
                      >
                        Insert
                      </button>
                      <button
                        type="button"
                        className="suggestionActionBtn primary"
                        style={{ backgroundColor: "#2563eb", color: "#ffffff", borderColor: "#2563eb" }}
                        title="Globally convert all mentions to links in-place"
                        onClick={() => onApplyWikiLinkSuggestion(mention.text)}
                      >
                        Link All
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Mentions in other Notes */}
        <div className="mentionsSubsection">
          <h5>In other Notes ({mentionsInOtherNotes.length})</h5>
          {isLoadingBacklinks ? (
            <div className="suggestionsEmptyState">Scanning backlinks...</div>
          ) : mentionsInOtherNotes.length === 0 ? (
            <div className="suggestionsEmptyState">No unlinked mentions of this note in other notes.</div>
          ) : (
            <div className="suggestionsList">
              {mentionsInOtherNotes.map((suggestion) => (
                <div key={`mention-out-${suggestion.id}`} className="suggestionItem">
                  <div className="suggestionItemRow">
                    <span className="suggestionItemName">{suggestion.sourceTitle}</span>
                    <div className="suggestionItemActions">
                      <button
                        type="button"
                        className="suggestionActionBtn"
                        title="Insert link to source note at cursor"
                        onClick={() => onInsertLinkAtCursor(suggestion.sourceTitle)}
                      >
                        Insert
                      </button>
                      <button
                        type="button"
                        className="suggestionActionBtn primary"
                        style={{ backgroundColor: "#2563eb", color: "#ffffff", borderColor: "#2563eb" }}
                        title="Link unlinked mention inside source note"
                        onClick={() => void onApplyBacklinkSuggestion(suggestion)}
                      >
                        Link Mention
                      </button>
                      <button
                        type="button"
                        className="suggestionActionBtn"
                        title="View note"
                        onClick={() => void onNavigateNote(suggestion.sourcePath)}
                      >
                        View
                      </button>
                    </div>
                  </div>
                  {suggestion.excerpt && (
                    <p className="suggestionExcerpt" style={{ fontSize: "11px", color: "#64748b", marginTop: "4px" }}>
                      {suggestion.excerpt}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Semantic Recommendations section */}
      <section className="suggestionsSection">
        <h4>Semantic Recommendations ({semanticRecommendations.length})</h4>
        {isLoadingBacklinks ? (
          <div className="suggestionsEmptyState">Checking recommendations...</div>
        ) : semanticRecommendations.length === 0 ? (
          <div className="suggestionsEmptyState">No semantic recommendations found.</div>
        ) : (
          <div className="suggestionsList">
            {semanticRecommendations.map((rec) => {
              const scoreClass = rec.score >= 80 ? "high" : "medium";
              return (
                <div key={`semantic-${rec.path}`} className="suggestionItem">
                  <div className="suggestionItemRow">
                    <span className="suggestionItemName" title={rec.title}>
                      {rec.title}
                      <span className={`suggestionScoreBadge ${scoreClass}`}>{rec.score}% Match</span>
                    </span>
                    <div className="suggestionItemActions">
                      <button
                        type="button"
                        className="suggestionActionBtn"
                        title="Insert wiki link at cursor"
                        onClick={() => onInsertLinkAtCursor(rec.title)}
                      >
                        Insert
                      </button>
                      <button
                        type="button"
                        className="suggestionActionBtn"
                        title="View note"
                        onClick={() => void onNavigateNote(rec.path)}
                      >
                        View
                      </button>
                    </div>
                  </div>
                  {rec.excerpt && <p className="suggestionExcerpt">{rec.excerpt}</p>}
                  {rec.detail && (
                    <div className="suggestionDetailText" style={{ fontSize: "10px", color: "#94a3b8", marginTop: "2px" }}>
                      {rec.detail}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
