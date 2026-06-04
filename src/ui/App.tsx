import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { marked } from "marked";
import { useCallback, useEffect, useMemo, useState } from "react";
import { vaultApi } from "../api";
import { isDesktopRuntime, pickVaultFolder } from "../api/dialog";
import type { FileTreeNode, GitStatus, NoteDocument, Snapshot, VaultSnapshot } from "../api/types";
import type { GraphData, NoteContext, NoteMeta } from "../core/types";
import { getStartupVaultPath, rememberVaultPath } from "./vaultStartup";

type ViewMode = "edit" | "preview" | "graph";

export function App() {
  const [vault, setVault] = useState<VaultSnapshot | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [document, setDocument] = useState<NoteDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("edit");
  const [context, setContext] = useState<NoteContext | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [propertyFilter, setPropertyFilter] = useState("");
  const [results, setResults] = useState<NoteMeta[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
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

  async function selectNote(path: string) {
    const note = await vaultApi.readNote(path);
    setActivePath(path);
    setDocument(note);
    setDraft(note.content);
    setViewMode("edit");
    await refreshContext(path);
  }

  async function refreshContext(path: string) {
    setContext(await vaultApi.getNoteContext(path));
    setSnapshots(await vaultApi.listSnapshots(path));
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

  const html = useMemo(() => ({ __html: marked.parse(draft) as string }), [draft]);
  const allTags = useMemo(() => Array.from(new Set(vault?.notes.flatMap((note) => note.tags) ?? [])).sort(), [vault]);

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
          <h2>Files</h2>
          {vault?.tree.map((node) => (
            <TreeNode key={node.path} node={node} activePath={activePath} onSelect={(path) => void selectNote(path)} />
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
            <button className={viewMode === "edit" ? "active" : ""} onClick={() => setViewMode("edit")}>Edit</button>
            <button className={viewMode === "preview" ? "active" : ""} onClick={() => setViewMode("preview")}>Preview</button>
            <button className={viewMode === "graph" ? "active" : ""} onClick={() => setViewMode("graph")}>Graph</button>
          </div>
          <button className="primary" onClick={() => void saveActiveNote()}>Save</button>
        </header>

        {viewMode === "edit" && (
          <CodeMirror
            value={draft}
            height="100%"
            extensions={[markdown()]}
            theme="light"
            basicSetup={{ lineNumbers: true, foldGutter: true }}
            onChange={setDraft}
          />
        )}
        {viewMode === "preview" && <article className="preview" dangerouslySetInnerHTML={html} />}
        {viewMode === "graph" && graph && (
          <GraphView
            graph={graph}
            activePath={activePath}
            onOpen={(path) => void selectNote(path)}
            onCreateLink={(targetPath) => activePath && void createGraphLink(activePath, targetPath)}
            onDeleteLink={(targetPath) => activePath && void deleteGraphLink(activePath, targetPath)}
          />
        )}
      </section>

      <aside className="contextPane">
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

function TreeNode({ node, activePath, onSelect }: { node: FileTreeNode; activePath: string | null; onSelect(path: string): void }) {
  if (node.kind === "note") {
    return (
      <button className={node.path === activePath ? "treeItem active" : "treeItem"} onClick={() => onSelect(node.path)}>
        {node.name}
      </button>
    );
  }

  return (
    <details open>
      <summary>{node.name}</summary>
      <div className="treeChildren">
        {node.children.map((child) => <TreeNode key={child.path} node={child} activePath={activePath} onSelect={onSelect} />)}
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
