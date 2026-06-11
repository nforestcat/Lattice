import type { VaultSnapshot, FileTreeNode } from "../../api/types";

interface SidebarProps {
  vault: VaultSnapshot | null;
  chooseVaultFolder: () => Promise<void>;
  query: string;
  tagFilter: string;
  propertyFilter: string;
  allTags: string[];
  searchMode: "keyword" | "semantic";
  setSearchMode: (mode: "keyword" | "semantic") => void;
  runSearch: (query: string, tagFilter: string, propertyFilter: string, mode?: "keyword" | "semantic") => Promise<void>;
  setQuery: (query: string) => void;
  setTagFilter: (tagFilter: string) => void;
  setPropertyFilter: (propertyFilter: string) => void;
  createNoteInCurrentFolder: () => Promise<void>;
  createFolderInCurrentFolder: () => Promise<void>;
  activePath: string | null;
  selectNote: (path: string) => Promise<void> | void;
  renameTreeEntry: (path: string) => Promise<void> | void;
  deleteTreeEntry: (path: string, kind: FileTreeNode["kind"]) => Promise<void> | void;
  isSearchingSemantic: boolean;
  semanticSearchError: string | null;
  results: Array<{ path: string; title: string; similarity?: number }>;
  globalHealthScore: number | null;
  isScanningHealth: boolean;
  onGoToAuditor: () => void;
  onOpenIngest?: () => void;
}

export function Sidebar({
  vault,
  chooseVaultFolder,
  query,
  tagFilter,
  propertyFilter,
  allTags,
  searchMode,
  setSearchMode,
  runSearch,
  setQuery,
  setTagFilter,
  setPropertyFilter,
  createNoteInCurrentFolder,
  createFolderInCurrentFolder,
  activePath,
  selectNote,
  renameTreeEntry,
  deleteTreeEntry,
  isSearchingSemantic,
  semanticSearchError,
  results,
  globalHealthScore,
  isScanningHealth,
  onGoToAuditor,
  onOpenIngest,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand" style={{ display: "flex", flexDirection: "row", justifyContent: "space-between", alignItems: "center", width: "100%", gap: "8px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
          <strong>Lattice</strong>
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={vault?.rootPath ?? undefined}>
            {vault?.rootPath ?? "No vault"}
          </span>
        </div>
        {vault && (() => {
          const isLoading = isScanningHealth || globalHealthScore === null;
          let badgeClass = "health-loading";
          if (!isLoading && globalHealthScore !== null) {
            if (globalHealthScore >= 90) badgeClass = "health-perfect";
            else if (globalHealthScore >= 70) badgeClass = "health-warning";
            else badgeClass = "health-critical";
          }
          const badgeText = isLoading ? "Health --" : `❤️ ${globalHealthScore}%`;

          return (
            <button 
              className={`globalHealthBadgeButton ${badgeClass}`} 
              aria-label="Open Wiki Auditor"
              onClick={onGoToAuditor}
              title={isLoading ? "Auditing vault health..." : `Global Health Score: ${globalHealthScore}%. Click to view details in Auditor.`}
            >
              {isLoading && <span style={{ marginRight: "4px" }}>⌛</span>}
              {badgeText}
            </button>
          );
        })()}
      </div>
      <button className="primary" onClick={() => void chooseVaultFolder()}>Open vault</button>
      {onOpenIngest && (
        <button onClick={onOpenIngest} title="Import a web page or PDF as a note">
          Ingest URL / PDF
        </button>
      )}
      <SearchPanel
        query={query}
        tagFilter={tagFilter}
        propertyFilter={propertyFilter}
        tags={allTags}
        searchMode={searchMode}
        onSearchModeChange={(mode) => {
          setSearchMode(mode);
          void runSearch(query, tagFilter, propertyFilter, mode);
        }}
        onSubmit={() => {
          void runSearch(query, tagFilter, propertyFilter);
        }}
        onQuery={(value) => {
          setQuery(value);
          if (searchMode === "keyword") {
            void runSearch(value, tagFilter, propertyFilter);
          }
        }}
        onTag={(value) => {
          setTagFilter(value);
          void runSearch(query, value, propertyFilter);
        }}
        onProperty={(value) => {
          setPropertyFilter(value);
          void runSearch(query, tagFilter, value);
        }}
      />
      <section className="tree">
        <div className="sectionHeader">
          <h2>Files</h2>
          <div className="inlineActions">
            <button title="New note" onClick={() => void createNoteInCurrentFolder()}>+</button>
            <button title="New folder" onClick={() => void createFolderInCurrentFolder()}>Folder</button>
          </div>
        </div>
        {vault?.tree.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            activePath={activePath}
            onSelect={(path) => void selectNote(path)}
            onRename={(path) => void renameTreeEntry(path)}
            onDelete={(path, kind) => void deleteTreeEntry(path, kind)}
          />
        ))}
      </section>
      <section className="results">
        <h2>Search {searchMode === "semantic" ? "(Semantic)" : ""}</h2>
        {isSearchingSemantic && (
          <div className="searchLoadingText">
            <span className="spinner">⌛</span> Searching semantically...
          </div>
        )}
        {semanticSearchError && (
          <div className="searchErrorText">{semanticSearchError}</div>
        )}
        {!isSearchingSemantic && results.length === 0 && query.trim() !== "" && (
          <div className="muted" style={{ padding: "4px 0" }}>No notes found.</div>
        )}
        {!isSearchingSemantic && results.map((note) => (
          <button key={note.path} className="result" onClick={() => void selectNote(note.path)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
              <strong>{note.title}</strong>
              {note.similarity !== undefined && (
                <span className="similarityBadge">
                  {Math.round(note.similarity * 100)}% Match
                </span>
              )}
            </div>
            <span>{note.path}</span>
          </button>
        ))}
      </section>
    </aside>
  );
}

function SearchPanel(props: {
  query: string;
  tagFilter: string;
  propertyFilter: string;
  tags: string[];
  searchMode: "keyword" | "semantic";
  onSearchModeChange(mode: "keyword" | "semantic"): void;
  onSubmit(): void;
  onQuery(value: string): void;
  onTag(value: string): void;
  onProperty(value: string): void;
}) {
  return (
    <section className="searchPanel">
      <div className="searchModeToggle">
        <button
          type="button"
          className={props.searchMode === "keyword" ? "active" : ""}
          onClick={() => props.onSearchModeChange("keyword")}
        >
          Keyword
        </button>
        <button
          type="button"
          className={props.searchMode === "semantic" ? "active" : ""}
          onClick={() => props.onSearchModeChange("semantic")}
        >
          Semantic
        </button>
      </div>
      <div className="searchInputContainer">
        <input
          value={props.query}
          onChange={(event) => props.onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              props.onSubmit();
            }
          }}
          placeholder={props.searchMode === "semantic" ? "Semantic query (Enter)..." : "Search notes"}
        />
        {props.searchMode === "semantic" && (
          <button type="button" onClick={props.onSubmit} className="btnSemanticSearch">
            Go
          </button>
        )}
      </div>
      {props.searchMode === "keyword" && (
        <>
          <select value={props.tagFilter} onChange={(event) => props.onTag(event.target.value)}>
            <option value="">All tags</option>
            {props.tags.map((tag) => <option key={tag} value={tag}>#{tag}</option>)}
          </select>
          <input value={props.propertyFilter} onChange={(event) => props.onProperty(event.target.value)} placeholder="status=draft" />
        </>
      )}
    </section>
  );
}

function TreeNode({
  node,
  activePath,
  onSelect,
  onRename,
  onDelete
}: {
  node: FileTreeNode;
  activePath: string | null;
  onSelect(path: string): void;
  onRename(path: string): void;
  onDelete(path: string, kind: FileTreeNode["kind"]): void;
}) {
  const actions = (
    <span className="treeActions">
      <button title={`Rename ${node.name}`} onClick={(event) => {
        event.stopPropagation();
        onRename(node.path);
      }}>Rename</button>
      <button title={`Delete ${node.name}`} onClick={(event) => {
        event.stopPropagation();
        onDelete(node.path, node.kind);
      }}>Delete</button>
    </span>
  );

  if (node.kind === "note") {
    return (
      <div className={node.path === activePath ? "treeRow active" : "treeRow"}>
        <button className="treeItem" onClick={() => onSelect(node.path)}>{node.name}</button>
        {actions}
      </div>
    );
  }

  return (
    <details open>
      <summary>
        <span>{node.name}</span>
        {actions}
      </summary>
      <div className="treeChildren">
        {node.children.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            activePath={activePath}
            onSelect={onSelect}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
      </div>
    </details>
  );
}
