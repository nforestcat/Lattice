import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { useCallback, useMemo, useState } from "react";
import { cosineSimilarity, type VectorCache } from "../../api/embeddings";
import type { GraphData, NoteMeta, NoteHealthReport, UnresolvedLinkGroup } from "../../api/types";

export function GraphView(props: {
  graph: GraphData;
  activePath: string | null;
  embeddingsCache: VectorCache;
  notes: NoteMeta[];
  healthReports: NoteHealthReport[];
  onOpen(path: string): void;
  onCreateLink(path: string): void;
  onDeleteLink(path: string): void;
  activeUnresolvedTarget: string | null;
  unresolvedLinks: UnresolvedLinkGroup[];
  onSelectUnresolved(target: string): void;
  onOpenUnresolved(target: string): void;
  onDraftUnresolved(target: string): void;
}) {
  const [showFiltersPanel, setShowFiltersPanel] = useState(false);
  const [excludedTags, setExcludedTags] = useState<Set<string>>(new Set());
  const [frontmatterQuery, setFrontmatterQuery] = useState("");
  const [semanticThreshold, setSemanticThreshold] = useState(0.5);
  const [showOnlyUnhealthy, setShowOnlyUnhealthy] = useState(false);

  const healthByPath = useMemo(() => {
    const map = new Map<string, number>();
    props.healthReports?.forEach(r => map.set(r.path, r.score));
    return map;
  }, [props.healthReports]);

  const activeGhostNode = useMemo(() => {
    if (!props.activeUnresolvedTarget) return null;
    return props.graph.nodes.find(n => n.id === `unresolved:${props.activeUnresolvedTarget}`);
  }, [props.graph.nodes, props.activeUnresolvedTarget]);

  const allUniqueTags = useMemo(() => {
    const set = new Set<string>();
    props.graph.nodes.forEach(node => {
      node.tags.forEach(tag => set.add(tag));
    });
    return Array.from(set).sort();
  }, [props.graph.nodes]);

  const visibleNodeIds = useMemo(() => {
    const ids = new Set<string>();
    props.graph.nodes.forEach(node => {
      // 0. Health filter check
      if (showOnlyUnhealthy) {
        const score = healthByPath.get(node.id);
        if (score === undefined || score === 100) return;
      }

      // 1. Tag check: if it contains any tag that is checked to be excluded
      const hasExcludedTag = node.tags.some(tag => excludedTags.has(tag));
      if (hasExcludedTag) return;

      // 2. Frontmatter query check
      const query = frontmatterQuery.trim().toLowerCase();
      if (query) {
        const parts = query.includes(":") ? query.split(":") : query.split("=");
        const filterKey = parts[0].trim();
        const noteMeta = props.notes.find(n => n.path === node.id);
        if (!noteMeta) return; // Hide if metadata is missing

        if (parts.length >= 2) {
          const filterVal = parts[1].trim();
          const fmValue = String(noteMeta.frontmatter[filterKey] || "").toLowerCase();
          if (!fmValue.includes(filterVal)) {
            return;
          }
        } else {
          if (!(filterKey in noteMeta.frontmatter)) {
            return;
          }
        }
      }

      ids.add(node.id);
    });
    return ids;
  }, [props.graph.nodes, props.notes, excludedTags, frontmatterQuery, showOnlyUnhealthy, healthByPath]);

  const nodes = useMemo<Node[]>(() => {
    // Only include visible nodes
    const graphNodes = props.graph.nodes.filter(node => visibleNodeIds.has(node.id));
    const n = graphNodes.length;
    if (n === 0) return [];

    // Initialize positions in a circle to start force layout simulation
    const positions = graphNodes.map((node, index) => {
      const angle = (index / n) * 2 * Math.PI;
      const radius = 120 + n * 8;
      return {
        id: node.id,
        x: Math.cos(angle) * radius + 300,
        y: Math.sin(angle) * radius + 300
      };
    });

    const semanticLinks: { source: string; target: string; similarity: number }[] = [];

    // Find all semantic links between all pairs of visible nodes
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const idA = graphNodes[i].id;
        const idB = graphNodes[j].id;
        const vecA = props.embeddingsCache[idA]?.vector;
        const vecB = props.embeddingsCache[idB]?.vector;
        if (vecA && vecB) {
          const similarity = cosineSimilarity(vecA, vecB);
          if (similarity >= semanticThreshold) {
            semanticLinks.push({ source: idA, target: idB, similarity });
          }
        }
      }
    }

    // Force-directed layout parameters
    const width = 800;
    const height = 600;
    const iterations = 80;
    const k = Math.sqrt((width * height) / n) * 0.9; // Ideal distance

    // Run simple spring layout simulation
    for (let iter = 0; iter < iterations; iter++) {
      const dxs = new Array(n).fill(0);
      const dys = new Array(n).fill(0);

      // 1. Repulsion between all visible nodes
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const xDist = positions[i].x - positions[j].x;
          const yDist = positions[i].y - positions[j].y;
          let dist = Math.sqrt(xDist * xDist + yDist * yDist);
          if (dist === 0) dist = 0.1;
          
          const force = (k * k) / dist;
          dxs[i] += (xDist / dist) * force;
          dys[i] += (yDist / dist) * force;
        }
      }

      // 2. Attraction along hard wiki links (only between visible nodes)
      for (const edge of props.graph.edges) {
        if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) continue;
        const idxS = graphNodes.findIndex((node) => node.id === edge.source);
        const idxT = graphNodes.findIndex((node) => node.id === edge.target);
        if (idxS === -1 || idxT === -1) continue;

        const xDist = positions[idxS].x - positions[idxT].x;
        const yDist = positions[idxS].y - positions[idxT].y;
        let dist = Math.sqrt(xDist * xDist + yDist * yDist);
        if (dist === 0) dist = 0.1;

        const force = (dist * dist) / k;
        dxs[idxS] -= (xDist / dist) * force;
        dys[idxS] -= (yDist / dist) * force;
        dxs[idxT] += (xDist / dist) * force;
        dys[idxT] += (yDist / dist) * force;
      }

      // 3. Attraction along semantic links (only between visible nodes)
      for (const semLink of semanticLinks) {
        const idxS = graphNodes.findIndex((node) => node.id === semLink.source);
        const idxT = graphNodes.findIndex((node) => node.id === semLink.target);
        if (idxS === -1 || idxT === -1) continue;

        const xDist = positions[idxS].x - positions[idxT].x;
        const yDist = positions[idxS].y - positions[idxT].y;
        let dist = Math.sqrt(xDist * xDist + yDist * yDist);
        if (dist === 0) dist = 0.1;

        const force = ((dist * dist) / k) * (semLink.similarity * 0.45);
        dxs[idxS] -= (xDist / dist) * force;
        dys[idxS] -= (yDist / dist) * force;
        dxs[idxT] += (xDist / dist) * force;
        dys[idxT] += (yDist / dist) * force;
      }

      // 4. Update coordinates with temperature cooling
      const temp = 50 * (1 - iter / iterations);
      for (let i = 0; i < n; i++) {
        const disp = Math.sqrt(dxs[i] * dxs[i] + dys[i] * dys[i]);
        if (disp === 0) continue;
        const cappedDisp = Math.min(disp, temp);
        positions[i].x += (dxs[i] / disp) * cappedDisp;
        positions[i].y += (dys[i] / disp) * cappedDisp;
      }
    }

    return graphNodes.map((node, index) => {
      const pos = positions[index];
      const id = node.id;
      
      let cls = "graphNode";
      
      if (node.kind === "unresolved") {
        cls += " ghost-node";
      } else {
        // Health style outline precedence
        const score = healthByPath.get(id);
        if (score !== undefined && score < 100) {
          if (score < 70) {
            cls += " health-critical";
          } else {
            cls += " health-warning";
          }
        }
      }

      if (node.kind === "unresolved") {
        if (id === `unresolved:${props.activeUnresolvedTarget}`) {
          cls += " active";
        }
      } else {
        if (id === props.activePath) {
          cls += " active";
        } else if (props.activePath) {
          const vecActive = props.embeddingsCache[props.activePath]?.vector;
          const vecNode = props.embeddingsCache[id]?.vector;
          if (vecActive && vecNode) {
            const sim = cosineSimilarity(vecActive, vecNode);
            if (sim >= 0.7) {
              cls += " semantic-high";
            } else if (sim >= 0.5) {
              cls += " semantic-medium";
            }
          }
        }
      }

      return {
        id,
        position: { x: pos.x, y: pos.y },
        data: { label: node.label },
        className: cls
      };
    });
  }, [props.graph.nodes, props.graph.edges, props.activePath, props.embeddingsCache, visibleNodeIds, semanticThreshold, healthByPath, props.healthReports, showOnlyUnhealthy, props.activeUnresolvedTarget]);

  const edges = useMemo<Edge[]>(() => {
    const graphNodes = props.graph.nodes.filter(node => visibleNodeIds.has(node.id));
    const list: Edge[] = [];

    // 1. Render hard wiki links (only between visible nodes)
    for (const edge of props.graph.edges) {
      if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) continue;
      list.push({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        animated: edge.isManaged,
        style: { stroke: edge.isManaged ? "#3b82f6" : "#cbd5e1", strokeWidth: 2 }
      });
    }

    // 2. Render dotted semantic connections from the active note (only to visible nodes)
    const activePath = props.activePath;
    if (activePath && visibleNodeIds.has(activePath)) {
      const vecActive = props.embeddingsCache[activePath]?.vector;
      if (vecActive) {
        for (const node of graphNodes) {
          if (node.id === activePath) continue;
          const vecNode = props.embeddingsCache[node.id]?.vector;
          if (vecNode) {
            const sim = cosineSimilarity(vecActive, vecNode);
            if (sim >= semanticThreshold) {
              list.push({
                id: `semantic-${activePath}-${node.id}`,
                source: activePath,
                target: node.id,
                animated: true,
                style: { stroke: "#10b981", strokeWidth: 1.5, strokeDasharray: "4 4" },
                label: `${Math.round(sim * 100)}% Match`,
                labelStyle: { fill: "#047857", fontSize: 9, fontWeight: 600 }
              });
            }
          }
        }
      }
    }

    return list;
  }, [props.graph.nodes, props.graph.edges, props.activePath, props.embeddingsCache, visibleNodeIds, semanticThreshold]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.id.startsWith("unresolved:")) {
      const normalizedTarget = node.id.replace("unresolved:", "");
      props.onSelectUnresolved(normalizedTarget);
    } else {
      props.onOpen(node.id);
    }
  }, [props]);
  const otherNodes = props.graph.nodes
    .filter((node) => node.kind !== "unresolved")
    .filter((node) => node.id !== props.activePath)
    .filter((node) => visibleNodeIds.has(node.id));

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
        <button
          type="button"
          className="graph-filter-toggle-btn"
          onClick={() => setShowFiltersPanel(!showFiltersPanel)}
          style={{
            padding: "4px 8px",
            fontSize: "12px",
            background: showFiltersPanel ? "#cbd5e1" : "none",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
            cursor: "pointer",
            fontWeight: 500
          }}
        >
          🔍 Filter Graph
        </button>
      </div>

      {activeGhostNode && (
        <div className="ghost-node-banner" style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 16px",
          background: "#f8fafc",
          borderBottom: "1px solid #e2e8f0",
          fontSize: "12px",
          color: "#334155",
          gap: "12px"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{
              display: "inline-block",
              padding: "2px 6px",
              background: "#e2e8f0",
              color: "#475569",
              borderRadius: "4px",
              fontSize: "10px",
              fontWeight: 700,
              textTransform: "uppercase"
            }}>Unresolved Page</span>
            <span>
              Note <strong>"{activeGhostNode.label}"</strong> is referenced but has not been created yet.
            </span>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              className="smallButton"
              onClick={() => props.onOpenUnresolved(props.activeUnresolvedTarget!)}
              style={{
                padding: "4px 8px",
                fontSize: "11px",
                cursor: "pointer",
                background: "#fff",
                border: "1px solid #cbd5e1",
                borderRadius: "4px"
              }}
            >
              Open in Auditor
            </button>
            <button
              type="button"
              className="smallButton primary"
              onClick={() => props.onDraftUnresolved(props.activeUnresolvedTarget!)}
              style={{
                padding: "4px 8px",
                fontSize: "11px",
                cursor: "pointer",
                background: "#2563eb",
                color: "#fff",
                border: "none",
                borderRadius: "4px"
              }}
            >
              Draft AI Stub
            </button>
          </div>
        </div>
      )}

      {showFiltersPanel && (
        <div className="graphFiltersPanel" style={{
          padding: "12px",
          background: "rgba(248, 250, 252, 0.9)",
          borderBottom: "1px solid #e2e8f0",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          fontSize: "12px"
        }}>
          <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: "200px" }}>
              <h4 style={{ margin: "0 0 6px 0", fontSize: "12px", color: "#334155" }}>Filter by Tags</h4>
              <div className="graphFilterTagsList" style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "6px",
                maxHeight: "80px",
                overflowY: "auto",
                padding: "4px",
                border: "1px solid #e2e8f0",
                borderRadius: "6px",
                background: "#fff"
              }}>
                {allUniqueTags.length === 0 ? (
                  <span className="muted" style={{ fontSize: "11px", color: "#94a3b8" }}>No tags in graph</span>
                ) : (
                  allUniqueTags.map(tag => {
                    const isChecked = !excludedTags.has(tag);
                    return (
                      <label key={tag} style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "11px", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          className="tag-filter-checkbox"
                          checked={isChecked}
                          onChange={() => {
                            setExcludedTags(prev => {
                              const next = new Set(prev);
                              if (next.has(tag)) {
                                next.delete(tag);
                              } else {
                                next.add(tag);
                              }
                              return next;
                            });
                          }}
                        />
                        <span>#{tag}</span>
                      </label>
                    );
                  })
                )}
              </div>
            </div>
            
            <div style={{ flex: 1, minWidth: "180px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div>
                <h4 style={{ margin: "0 0 4px 0", fontSize: "12px", color: "#334155" }}>Filter by Health</h4>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", cursor: "pointer", marginBottom: "8px" }}>
                  <input
                    type="checkbox"
                    className="health-filter-checkbox"
                    checked={showOnlyUnhealthy}
                    onChange={(e) => setShowOnlyUnhealthy(e.target.checked)}
                  />
                  <span>Show only notes with health issues</span>
                </label>
              </div>

              <div>
                <h4 style={{ margin: "0 0 4px 0", fontSize: "12px", color: "#334155" }}>Filter by Metadata</h4>
                <input
                  type="text"
                  className="metadata-filter-input"
                  placeholder="e.g. status: draft"
                  value={frontmatterQuery}
                  onChange={(e) => setFrontmatterQuery(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "4px 8px",
                    fontSize: "11px",
                    borderRadius: "4px",
                    border: "1px solid #cbd5e1"
                  }}
                />
              </div>

              <div>
                <h4 style={{ margin: "0 0 4px 0", fontSize: "12px", color: "#334155", display: "flex", justifyContent: "space-between" }}>
                  <span>Semantic Threshold</span>
                  <span style={{ fontWeight: 600, color: "#10b981" }}>{semanticThreshold.toFixed(2)}</span>
                </h4>
                <input
                  type="range"
                  className="semantic-threshold-slider"
                  min="0.0"
                  max="1.0"
                  step="0.05"
                  value={semanticThreshold}
                  onChange={(e) => setSemanticThreshold(parseFloat(e.target.value))}
                  style={{ width: "100%", cursor: "pointer" }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      <ReactFlow nodes={nodes} edges={edges} onNodeClick={onNodeClick} fitView>
        <Background />
        <MiniMap />
        <Controls />
      </ReactFlow>
    </div>
  );
}
