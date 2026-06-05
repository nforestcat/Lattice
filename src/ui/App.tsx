import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { marked } from "marked";
import { useCallback, useEffect, useMemo, useState } from "react";
import { vaultApi } from "../api";
import { isDesktopRuntime, pickVaultFolder } from "../api/dialog";
import type { ContextBundle, ContextBundleCandidate, FileTreeNode, GitStatus, NoteDocument, Snapshot, VaultSnapshot } from "../api/types";
import type { InboxCaptureBlock } from "../core/capture";
import type { GraphData, NoteContext, NoteMeta } from "../core/types";
import { getStartupVaultPath, rememberVaultPath } from "./vaultStartup";

type ViewMode = "split" | "edit" | "preview" | "graph";

export function App() {
  const [vault, setVault] = useState<VaultSnapshot | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [document, setDocument] = useState<NoteDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [context, setContext] = useState<NoteContext | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [propertyFilter, setPropertyFilter] = useState("");
  const [results, setResults] = useState<NoteMeta[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [contextBundle, setContextBundle] = useState<ContextBundle | null>(null);
  const [contextCandidates, setContextCandidates] = useState<ContextBundleCandidate[]>([]);
  const [selectedContextPaths, setSelectedContextPaths] = useState<Set<string>>(new Set());
  const [bundlePurpose, setBundlePurpose] = useState("");
  const [bundleMode, setBundleMode] = useState<"short" | "standard" | "full">("standard");
  const [inboxCaptures, setInboxCaptures] = useState<InboxCaptureBlock[]>([]);
  const [triageCaptureToAppend, setTriageCaptureToAppend] = useState<{ id: string; title: string } | null>(null);
  const [noteSearchQuery, setNoteSearchQuery] = useState("");
  const [captureDraft, setCaptureDraft] = useState("");
  const [status, setStatus] = useState("Ready");

  useEffect(() => {
    void openVault(getStartupVaultPath(window.localStorage, isDesktopRuntime()));
  }, []);

  useEffect(() => {
    if (!activePath) {
      return;
    }

    void refreshContext(activePath);
  }, [activePath]);

  async function openVault(path: string) {
    const nextVault = await vaultApi.openVault(path);
    setVault(nextVault);
    setResults(nextVault.notes);
    setActivePath(null);
    setDocument(null);
    setDraft("");
    setContext(null);
    setContextCandidates([]);
    setSelectedContextPaths(new Set());
    setInboxCaptures([]);
    setStatus(`Opened ${nextVault.rootPath}`);
    if (nextVault.notes[0]) {
      await selectNote(nextVault.notes[0].path);
    }
    setGraph(await vaultApi.getGraph());
    setGitStatus(await vaultApi.getGitStatus());
  }

  async function chooseVaultFolder() {
    const selectedPath = await pickVaultFolder();
    if (!selectedPath) {
      setStatus("Vault selection cancelled");
      return;
    }

    rememberVaultPath(window.localStorage, selectedPath);
    await openVault(selectedPath);
  }

  async function refreshVault(selectedPath: string | null) {
    const nextVault = await vaultApi.openVault(vault?.rootPath ?? "Demo Vault");
    setVault(nextVault);
    setResults(nextVault.notes);
    setGraph(await vaultApi.getGraph());
    setGitStatus(await vaultApi.getGitStatus());
    if (selectedPath) {
      await selectNote(selectedPath);
    } else {
      setActivePath(null);
      setDocument(null);
      setDraft("");
      setContext(null);
      setContextCandidates([]);
      setSelectedContextPaths(new Set());
      setInboxCaptures([]);
    }
  }

  async function selectNote(path: string) {
    const note = await vaultApi.readNote(path);
    setActivePath(path);
    setDocument(note);
    setDraft(note.content);
    setViewMode("split");
    await refreshContext(path);
  }

  async function refreshContext(path: string) {
    setContext(await vaultApi.getNoteContext(path));
    setSnapshots(await vaultApi.listSnapshots(path));
    setContextBundle(null);
    const candidates = await vaultApi.getContextBundleCandidates(path);
    setContextCandidates(candidates);
    setSelectedContextPaths(new Set(candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.path)));
    setInboxCaptures(isInboxPath(path) ? await vaultApi.getInboxCaptures(path) : []);
    setGraph(await vaultApi.getGraph());
    setGitStatus(await vaultApi.getGitStatus());
  }

  async function saveActiveNote() {
    if (!document) {
      return;
    }

    const result = await vaultApi.saveNote(document.path, draft, document.revision);
    if (result.conflict) {
      setStatus("Conflict detected. Snapshot created before overwriting.");
      await refreshContext(document.path);
      return;
    }

    setDocument({ ...document, content: draft, revision: result.revision });
    setStatus(result.gitCommit ? `Saved and committed ${result.gitCommit}` : "Saved");
    await refreshContext(document.path);
  }

  async function runSearch(nextQuery = query, nextTag = tagFilter, nextProperty = propertyFilter) {
    const frontmatter = parsePropertyFilter(nextProperty);
    const notes = await vaultApi.searchNotes({
      query: nextQuery,
      tags: nextTag ? [nextTag] : [],
      frontmatter
    });
    setResults(notes);
  }

  async function restoreSnapshot(snapshotId: string) {
    await vaultApi.restoreSnapshot(snapshotId);
    if (activePath) {
      await selectNote(activePath);
      setStatus("Snapshot restored");
    }
  }

  async function toggleAutoGit(enabled: boolean) {
    await vaultApi.setAutoGit(enabled);
    setGitStatus(await vaultApi.getGitStatus());
  }

  async function createGraphLink(sourcePath: string, targetPath: string) {
    const result = await vaultApi.createGraphLink(sourcePath, targetPath);
    setGraph(result.graph);
    if (sourcePath === activePath) {
      setDocument(result.note);
      setDraft(result.note.content);
    }
    setStatus("Graph link added to ## Links");
    await refreshContext(sourcePath);
  }

  async function deleteGraphLink(sourcePath: string, targetPath: string) {
    const result = await vaultApi.deleteManagedGraphLink(sourcePath, targetPath);
    setGraph(result.graph);
    if (sourcePath === activePath) {
      setDocument(result.note);
      setDraft(result.note.content);
    }
    setStatus("Managed graph link removed");
    await refreshContext(sourcePath);
  }

  async function createNoteInCurrentFolder() {
    const title = window.prompt("New note name");
    if (!title) {
      return;
    }
    try {
      const result = await vaultApi.createNote(currentFolderPath(activePath), title);
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Created ${result.selectedPath}`);
      if (result.selectedPath) {
        await selectNote(result.selectedPath);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function createFolderInCurrentFolder() {
    const name = window.prompt("New folder name");
    if (!name) {
      return;
    }
    try {
      const result = await vaultApi.createFolder(currentFolderPath(activePath), name);
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Created folder ${result.selectedPath}`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function renameTreeEntry(path: string) {
    const currentName = path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
    const newName = window.prompt("Rename", currentName);
    if (!newName || newName === currentName) {
      return;
    }
    try {
      const result = await vaultApi.renameEntry(path, newName);
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Renamed to ${result.selectedPath}`);
      if (result.selectedPath?.endsWith(".md")) {
        await selectNote(result.selectedPath);
      } else {
        await refreshVault(activePath);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function deleteTreeEntry(path: string, kind: FileTreeNode["kind"]) {
    const message = kind === "folder"
      ? `Delete empty folder "${path}"? Non-empty folders are refused.`
      : `Delete note "${path}"?`;
    if (!window.confirm(message)) {
      return;
    }
    try {
      const result = await vaultApi.deleteEntry(path);
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Deleted ${path}`);
      if (result.selectedPath) {
        await selectNote(result.selectedPath);
      } else {
        setActivePath(null);
        setDocument(null);
        setDraft("");
        setContext(null);
        setContextCandidates([]);
        setSelectedContextPaths(new Set());
        setInboxCaptures([]);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function generateContextBundle() {
    if (!activePath) {
      return;
    }
    try {
      const bundle = await vaultApi.getContextBundle(activePath, {
        selectedPaths: contextCandidates.filter((candidate) => selectedContextPaths.has(candidate.path)).map((candidate) => candidate.path),
        purpose: bundlePurpose,
        mode: bundleMode
      });
      setContextBundle(bundle);
      setStatus(`Context bundle includes ${bundle.notePaths.length} notes`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  function toggleContextCandidate(path: string) {
    setSelectedContextPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
    setContextBundle(null);
  }

  async function copyContextBundle() {
    if (!contextBundle) {
      return;
    }
    try {
      await navigator.clipboard.writeText(contextBundle.markdown);
      setStatus("Context bundle copied");
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function captureToInbox() {
    if (!vault || !captureDraft.trim()) {
      return;
    }
    try {
      const result = await vaultApi.captureToInbox({
        content: captureDraft,
        relatedPath: activePath,
        capturedAt: new Date().toISOString()
      });
      setCaptureDraft("");
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Captured to ${result.selectedPath}`);
      if (result.selectedPath) {
        await selectNote(result.selectedPath);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function promoteInboxCapture(captureId: string) {
    if (!activePath) {
      return;
    }
    const title = window.prompt("New note title");
    if (!title) {
      return;
    }
    try {
      const result = await vaultApi.promoteInboxCapture({
        inboxPath: activePath,
        captureId,
        title
      });
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Promoted to ${result.selectedPath}`);
      if (result.selectedPath) {
        await selectNote(result.selectedPath);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function markInboxCaptureProcessed(captureId: string) {
    if (!activePath) {
      return;
    }
    try {
      const result = await vaultApi.markInboxCaptureProcessed(activePath, captureId);
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus("Capture marked processed");
      await selectNote(activePath);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function handleAppendCapture(targetPath: string) {
    if (!activePath || !triageCaptureToAppend) {
      return;
    }
    try {
      const result = await vaultApi.appendInboxCapture({
        inboxPath: activePath,
        captureId: triageCaptureToAppend.id,
        targetPath
      });
      setTriageCaptureToAppend(null);
      setNoteSearchQuery("");
      setVault(result.vault);
      setResults(result.vault.notes);
      setStatus(`Appended capture to ${result.selectedPath}`);
      if (result.selectedPath) {
        await selectNote(result.selectedPath);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  const html = useMemo(() => ({ __html: marked.parse(draft) as string }), [draft]);
  const allTags = useMemo(() => Array.from(new Set(vault?.notes.flatMap((note) => note.tags) ?? [])).sort(), [vault]);
  const selectedContextCount = contextCandidates.filter((candidate) => selectedContextPaths.has(candidate.path)).length;
  const selectedContextCharacters = contextCandidates
    .filter((candidate) => selectedContextPaths.has(candidate.path))
    .reduce((total, candidate) => total + candidate.characterCount, 0);

  return (
    <main className="workspace">
      <aside className="sidebar">
        <div className="brand">
          <strong>Local Vault</strong>
          <span>{vault?.rootPath ?? "No vault"}</span>
        </div>
        <button className="primary" onClick={() => void chooseVaultFolder()}>Open vault</button>
        <SearchPanel
          query={query}
          tagFilter={tagFilter}
          propertyFilter={propertyFilter}
          tags={allTags}
          onQuery={(value) => {
            setQuery(value);
            void runSearch(value, tagFilter, propertyFilter);
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
          <h2>Search</h2>
          {results.map((note) => (
            <button key={note.path} className="result" onClick={() => void selectNote(note.path)}>
              <strong>{note.title}</strong>
              <span>{note.path}</span>
            </button>
          ))}
        </section>
      </aside>

      <section className="editorPane">
        <header className="topbar">
          <div>
            <strong>{context?.note.title ?? "Select a note"}</strong>
            <span>{activePath}</span>
          </div>
          <div className="segmented">
            <button className={viewMode === "split" ? "active" : ""} onClick={() => setViewMode("split")}>Split</button>
            <button className={viewMode === "edit" ? "active" : ""} onClick={() => setViewMode("edit")}>Edit</button>
            <button className={viewMode === "preview" ? "active" : ""} onClick={() => setViewMode("preview")}>Preview</button>
            <button className={viewMode === "graph" ? "active" : ""} onClick={() => setViewMode("graph")}>Graph</button>
          </div>
          <button className="primary" onClick={() => void saveActiveNote()}>Save</button>
        </header>

        <div className={`editorWorkspace ${viewMode === "split" ? "split" : "single"}`}>
          {(viewMode === "split" || viewMode === "edit") && (
            <section className="editorSurface">
              <CodeMirror
                value={draft}
                height="100%"
                extensions={[markdown()]}
                theme="light"
                basicSetup={{ lineNumbers: true, foldGutter: true }}
                onChange={setDraft}
              />
            </section>
          )}
          {(viewMode === "split" || viewMode === "preview") && (
            <article className="preview previewSurface" dangerouslySetInnerHTML={html} />
          )}
          {viewMode === "graph" && graph && (
            <section className="graphSurface">
              <GraphView
                graph={graph}
                activePath={activePath}
                onOpen={(path) => void selectNote(path)}
                onCreateLink={(targetPath) => activePath && void createGraphLink(activePath, targetPath)}
                onDeleteLink={(targetPath) => activePath && void deleteGraphLink(activePath, targetPath)}
              />
            </section>
          )}
        </div>
      </section>

      <aside className="contextPane">
        <section>
          <h2>LLM Context</h2>
          <div className="bundleSummary">
            <span>{selectedContextCount}/{contextCandidates.length} notes</span>
            <span>{selectedContextCharacters} chars</span>
          </div>
          <div className="bundleOptions">
            <div className="optionGroup">
              <label htmlFor="bundle-purpose">Purpose</label>
              <input
                id="bundle-purpose"
                type="text"
                placeholder="e.g. Summarize or refactor..."
                value={bundlePurpose}
                onChange={(event) => {
                  setBundlePurpose(event.target.value);
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
                  setBundleMode(event.target.value as any);
                  setContextBundle(null);
                }}
              >
                <option value="short">Short (Excerpt)</option>
                <option value="standard">Standard (Full)</option>
                <option value="full">Full (Full + Links)</option>
              </select>
            </div>
          </div>
          <div className="candidateList">
            {contextCandidates.map((candidate) => (
              <label key={candidate.path} className="candidateRow">
                <input
                  type="checkbox"
                  checked={selectedContextPaths.has(candidate.path)}
                  onChange={() => toggleContextCandidate(candidate.path)}
                />
                <span>
                  <strong>{candidate.title}</strong>
                  <small>{candidate.reason} · {candidate.characterCount} chars · {candidate.path}</small>
                </span>
              </label>
            ))}
          </div>
          <button onClick={() => void generateContextBundle()} disabled={!activePath || selectedContextCount === 0}>Generate bundle</button>
          {contextBundle && (
            <div className="bundleBox">
              <p className="muted">{contextBundle.notePaths.length} notes · {contextBundle.markdown.length} chars</p>
              <button onClick={() => void copyContextBundle()}>Copy bundle</button>
              <textarea readOnly value={contextBundle.markdown} />
            </div>
          )}
        </section>
        <section>
          <h2>Capture</h2>
          <textarea
            className="captureInput"
            placeholder="Paste an LLM answer, idea, or loose note..."
            value={captureDraft}
            onChange={(event) => setCaptureDraft(event.target.value)}
          />
          <p className="muted">{context ? `Related to [[${context.note.title}]]` : "No related note selected"}</p>
          <button onClick={() => void captureToInbox()} disabled={!vault || !captureDraft.trim()}>Capture to Inbox</button>
        </section>
        {activePath && isInboxPath(activePath) && (
          <section>
            <h2>Inbox Triage</h2>
            {inboxCaptures.length ? inboxCaptures.map((capture) => (
              <div key={capture.id} className="triageCard">
                <strong>{capture.title}</strong>
                {capture.relatedTitle && <small>Related: [[{capture.relatedTitle}]]</small>}
                <p>{capture.body}</p>
                <div className="inlineActions">
                  <button onClick={() => void promoteInboxCapture(capture.id)}>Create Note</button>
                  <button onClick={() => setTriageCaptureToAppend({ id: capture.id, title: capture.title })}>Append to Note</button>
                  <button onClick={() => void markInboxCaptureProcessed(capture.id)}>Mark Processed</button>
                </div>
              </div>
            )) : <p className="muted">No unprocessed captures</p>}
          </section>
        )}
        <section>
          <h2>Backlinks</h2>
          {context?.backlinks.length ? context.backlinks.map((link) => (
            <button key={`${link.sourcePath}-${link.line}`} onClick={() => void selectNote(link.sourcePath)}>
              {link.sourcePath}
            </button>
          )) : <p className="muted">No backlinks</p>}
        </section>
        <section>
          <h2>Outgoing</h2>
          {context?.outgoingLinks.map((link) => (
            <button key={`${link.targetRef}-${link.line}`} disabled={!link.resolvedPath} onClick={() => link.resolvedPath && void selectNote(link.resolvedPath)}>
              {link.targetRef}{link.isManaged ? " · managed" : ""}
            </button>
          ))}
        </section>
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
        <section>
          <h2>Snapshots</h2>
          {snapshots.map((snapshot) => (
            <button key={snapshot.id} onClick={() => void restoreSnapshot(snapshot.id)}>
              {new Date(snapshot.createdAt).toLocaleTimeString()} · {snapshot.reason}
            </button>
          ))}
        </section>
        <section>
          <h2>Git</h2>
          <label className="toggle">
            <input
              type="checkbox"
              checked={gitStatus?.autoGitEnabled ?? false}
              disabled={!gitStatus?.isRepo}
              onChange={(event) => void toggleAutoGit(event.target.checked)}
            />
            <span>Auto commit</span>
          </label>
          <p className="muted">{gitStatus?.isRepo ? `Branch ${gitStatus.branch}` : "Not a Git vault"}</p>
        </section>
        <p className="status">{status}</p>
      </aside>

      {triageCaptureToAppend && (
        <div className="modalOverlay" onClick={() => setTriageCaptureToAppend(null)}>
          <div className="modalContent" onClick={(event) => event.stopPropagation()}>
            <header className="modalHeader">
              <h3>Append Capture to Note</h3>
              <button className="closeButton" onClick={() => setTriageCaptureToAppend(null)}>&times;</button>
            </header>
            <div className="modalBody">
              <input
                type="text"
                placeholder="Search notes..."
                autoFocus
                value={noteSearchQuery}
                onChange={(event) => setNoteSearchQuery(event.target.value)}
              />
              <div className="noteList">
                {vault?.notes
                  .filter((note) => {
                    const q = noteSearchQuery.toLowerCase();
                    return note.title.toLowerCase().includes(q) || note.path.toLowerCase().includes(q);
                  })
                  .map((note) => (
                    <button
                      key={note.path}
                      className="noteSelectItem"
                      onClick={() => void handleAppendCapture(note.path)}
                    >
                      <strong>{note.title}</strong>
                      <span>{note.path}</span>
                    </button>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function SearchPanel(props: {
  query: string;
  tagFilter: string;
  propertyFilter: string;
  tags: string[];
  onQuery(value: string): void;
  onTag(value: string): void;
  onProperty(value: string): void;
}) {
  return (
    <section className="searchPanel">
      <input value={props.query} onChange={(event) => props.onQuery(event.target.value)} placeholder="Search notes" />
      <select value={props.tagFilter} onChange={(event) => props.onTag(event.target.value)}>
        <option value="">All tags</option>
        {props.tags.map((tag) => <option key={tag} value={tag}>#{tag}</option>)}
      </select>
      <input value={props.propertyFilter} onChange={(event) => props.onProperty(event.target.value)} placeholder="status=draft" />
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

function GraphView(props: {
  graph: GraphData;
  activePath: string | null;
  onOpen(path: string): void;
  onCreateLink(path: string): void;
  onDeleteLink(path: string): void;
}) {
  const nodes = useMemo<Node[]>(
    () =>
      props.graph.nodes.map((node, index) => ({
        id: node.id,
        position: { x: 80 + (index % 3) * 220, y: 80 + Math.floor(index / 3) * 160 },
        data: { label: node.label },
        className: node.id === props.activePath ? "graphNode active" : "graphNode"
      })),
    [props.graph.nodes, props.activePath]
  );
  const edges = useMemo<Edge[]>(
    () => props.graph.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, animated: edge.isManaged })),
    [props.graph.edges]
  );

  const onNodeClick = useCallback((_: unknown, node: Node) => props.onOpen(node.id), [props]);
  const otherNodes = props.graph.nodes.filter((node) => node.id !== props.activePath);

  return (
    <div className="graphShell">
      <div className="graphToolbar">
        <select onChange={(event) => event.target.value && props.onCreateLink(event.target.value)} defaultValue="">
          <option value="">Add link from current note</option>
          {otherNodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
        </select>
        <select onChange={(event) => event.target.value && props.onDeleteLink(event.target.value)} defaultValue="">
          <option value="">Remove managed link</option>
          {otherNodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
        </select>
      </div>
      <ReactFlow nodes={nodes} edges={edges} onNodeClick={onNodeClick} fitView>
        <Background />
        <MiniMap />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function parsePropertyFilter(value: string): Record<string, string> {
  if (!value.includes("=")) {
    return {};
  }
  const [key, ...rest] = value.split("=");
  return key.trim() ? { [key.trim()]: rest.join("=").trim() } : {};
}

function currentFolderPath(activePath: string | null): string | null {
  if (!activePath) {
    return null;
  }
  const index = activePath.lastIndexOf("/");
  return index === -1 ? null : activePath.slice(0, index);
}

function isInboxPath(path: string): boolean {
  return /^Inbox\/.+\.md$/i.test(path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
