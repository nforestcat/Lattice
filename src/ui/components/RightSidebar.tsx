import type { VaultSnapshot, NoteContext, Snapshot, GitStatus } from "../../api/types";
import type { InboxCaptureBlock } from "../../core/capture";
import type { InspectorPanelProps } from "./InspectorPanel";
import type { PromptHistoryPanelProps } from "./PromptHistoryPanel";
import type { EmbeddingsIndexPanelProps } from "./EmbeddingsIndexPanel";
import type { LinkSuggestionsSidebarProps } from "./LinkSuggestionsSidebar";
import { InspectorPanel } from "./InspectorPanel";
import { PromptHistoryPanel } from "./PromptHistoryPanel";
import { EmbeddingsIndexPanel } from "./EmbeddingsIndexPanel";
import { LinkSuggestionsSidebar } from "./LinkSuggestionsSidebar";

export interface RightSidebarProps {
  rightSidebarTab: "context" | "suggestions" | "index";
  setRightSidebarTab: (tab: "context" | "suggestions" | "index") => void;

  inspectorProps: InspectorPanelProps;
  promptHistoryProps: PromptHistoryPanelProps;
  embeddingsIndexProps: EmbeddingsIndexPanelProps;
  linkSuggestionsProps: LinkSuggestionsSidebarProps;

  vault: VaultSnapshot | null;
  context: NoteContext | null;
  activePath: string | null;
  showInboxTriage: boolean;
  status: string;

  capture: {
    draft: string;
    setDraft: (v: string) => void;
    onCaptureToInbox: () => void;
  };

  inboxTriage: {
    captures: InboxCaptureBlock[];
    onPromote: (id: string) => void;
    onMarkProcessed: (id: string) => void;
    setTriageCaptureToAppend: (v: { id: string; title: string } | null) => void;
  };

  metadata: {
    suggestions: { tags: string[]; frontmatter: Record<string, string> } | null;
    isGenerating: boolean;
    selectedTags: Set<string>;
    selectedProperties: Set<string>;
    onGenerate: () => void;
    onToggleTag: (tag: string) => void;
    onToggleProperty: (key: string) => void;
    onApply: () => void;
    onClear: () => void;
  };

  snapshots: {
    items: Snapshot[];
    onRestore: (id: string) => void;
  };

  git: {
    status: GitStatus | null;
    onToggleAutoGit: (enabled: boolean) => void;
  };
}

export function RightSidebar({
  rightSidebarTab,
  setRightSidebarTab,
  inspectorProps,
  promptHistoryProps,
  embeddingsIndexProps,
  linkSuggestionsProps,
  vault,
  context,
  activePath,
  showInboxTriage,
  status,
  capture,
  inboxTriage,
  metadata,
  snapshots,
  git,
}: RightSidebarProps) {
  return (
    <aside className="contextPane">
      <div className="rightSidebarTabs">
        <button
          type="button"
          className={rightSidebarTab === "context" ? "active" : ""}
          onClick={() => setRightSidebarTab("context")}
        >
          LLM Context
        </button>
        <button
          type="button"
          className={rightSidebarTab === "suggestions" ? "active" : ""}
          onClick={() => setRightSidebarTab("suggestions")}
        >
          Link Suggestions
        </button>
        <button
          type="button"
          className={rightSidebarTab === "index" ? "active" : ""}
          onClick={() => setRightSidebarTab("index")}
        >
          Index
        </button>
      </div>

      {rightSidebarTab === "index" ? (
        <EmbeddingsIndexPanel {...embeddingsIndexProps} />
      ) : rightSidebarTab === "suggestions" ? (
        <LinkSuggestionsSidebar {...linkSuggestionsProps} />
      ) : (
        <>
          <InspectorPanel {...inspectorProps} />
          <PromptHistoryPanel {...promptHistoryProps} />
          <section>
            <h2>Capture</h2>
            <textarea
              className="captureInput"
              placeholder="Paste an LLM answer, idea, or loose note..."
              value={capture.draft}
              onChange={(event) => capture.setDraft(event.target.value)}
            />
            <p className="muted">{context ? `Related to [[${context.note.title}]]` : "No related note selected"}</p>
            <button onClick={() => void capture.onCaptureToInbox()} disabled={!vault || !capture.draft.trim()}>Capture to Inbox</button>
          </section>
          {vault?.obsidianSettings?.detected && (
            <section>
              <h2>Obsidian</h2>
              <p className="property">Readable line length: {vault.obsidianSettings.readableLineLength ? "On" : "Off"}</p>
              {vault.obsidianSettings.theme && <p className="property">Theme: {vault.obsidianSettings.theme}</p>}
              {vault.obsidianSettings.accentColor && <p className="property">Accent: {vault.obsidianSettings.accentColor}</p>}
              {vault.obsidianSettings.attachmentFolderPath && (
                <p className="property">Attachments: <code>{vault.obsidianSettings.attachmentFolderPath}</code></p>
              )}
              {!!vault.obsidianSettings.cssSnippets?.length && (
                <p className="property">Snippets: {vault.obsidianSettings.cssSnippets.join(", ")}</p>
              )}
              {vault.obsidianSettings.hotkeys && (
                <p className="property">Hotkeys: {Object.keys(vault.obsidianSettings.hotkeys).length} custom hotkeys</p>
              )}
              {!!vault.obsidianSettings.enabledCorePlugins?.length && (
                <p className="muted">{vault.obsidianSettings.enabledCorePlugins.length} core plugins detected</p>
              )}
            </section>
          )}
          {showInboxTriage && (
            <section>
              <h2>Inbox Triage</h2>
              {inboxTriage.captures.length ? inboxTriage.captures.map((cap) => (
                <div key={cap.id} className="triageCard">
                  <strong>{cap.title}</strong>
                  {cap.relatedTitle && <small>Related: [[{cap.relatedTitle}]]</small>}
                  <p>{cap.body}</p>
                  <div className="inlineActions">
                    <button onClick={() => void inboxTriage.onPromote(cap.id)}>Create Note</button>
                    <button onClick={() => inboxTriage.setTriageCaptureToAppend({ id: cap.id, title: cap.title })}>Append to Note</button>
                    <button onClick={() => void inboxTriage.onMarkProcessed(cap.id)}>Mark Processed</button>
                  </div>
                </div>
              )) : <p className="muted">No unprocessed captures</p>}
            </section>
          )}
          <section>
            <h2>Tags</h2>
            <div className="chips">
              {context?.note.tags.map((tag) => <span key={tag}>#{tag}</span>)}
            </div>
          </section>
          <section>
            <h2>Properties</h2>
            {Object.entries(context?.note.frontmatter ?? {}).map(([key, value]) => (
              <p key={key} className="property"><strong>{key}</strong><span>{value}</span></p>
            ))}
          </section>
          <section className="metadataSuggestionsSection">
            <h2>AI Metadata Suggestions</h2>
            {metadata.isGenerating && (
              <p className="metadataSuggestionsLoading">Generating suggestions...</p>
            )}
            {!metadata.suggestions && !metadata.isGenerating && (
              <button
                className="suggest-btn"
                disabled={!activePath}
                onClick={() => void metadata.onGenerate()}
              >
                Suggest
              </button>
            )}
            {metadata.suggestions && !metadata.isGenerating && (
              <div className="metadataSuggestionsCard">
                {metadata.suggestions.tags.length > 0 && (
                  <div className="suggestedTagsGroup">
                    <h3>Suggested Tags</h3>
                    {metadata.suggestions.tags.map((tag) => (
                      <label key={tag} className="suggestedTagLabel">
                        <input
                          type="checkbox"
                          checked={metadata.selectedTags.has(tag)}
                          onChange={() => metadata.onToggleTag(tag)}
                        />
                        <span>#{tag}</span>
                      </label>
                    ))}
                  </div>
                )}
                {Object.keys(metadata.suggestions.frontmatter).length > 0 && (
                  <div className="suggestedPropertiesGroup">
                    <h3>Suggested Properties</h3>
                    {Object.entries(metadata.suggestions.frontmatter).map(([key, value]) => (
                      <label key={key} className="suggestedPropertyLabel">
                        <input
                          type="checkbox"
                          checked={metadata.selectedProperties.has(key)}
                          onChange={() => metadata.onToggleProperty(key)}
                        />
                        <strong>{key}:</strong> <span>{value}</span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="metadataSuggestionsActions">
                  <button
                    className="apply-btn"
                    onClick={() => void metadata.onApply()}
                  >
                    Apply Selected
                  </button>
                  <button
                    className="clear-btn"
                    onClick={metadata.onClear}
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
          </section>
          <section>
            <h2>Snapshots</h2>
            {snapshots.items.map((snapshot) => (
              <button key={snapshot.id} onClick={() => void snapshots.onRestore(snapshot.id)}>
                {new Date(snapshot.createdAt).toLocaleTimeString()} · {snapshot.reason}
              </button>
            ))}
          </section>
          <section>
            <h2>Git</h2>
            <label className="toggle">
              <input
                type="checkbox"
                checked={git.status?.autoGitEnabled ?? false}
                disabled={!git.status?.isRepo}
                onChange={(event) => void git.onToggleAutoGit(event.target.checked)}
              />
              <span>Auto commit</span>
            </label>
            <p className="muted">{git.status?.isRepo ? `Branch ${git.status.branch}` : "Not a Git vault"}</p>
          </section>
        </>
      )}
      <p className="status">{status}</p>
    </aside>
  );
}
