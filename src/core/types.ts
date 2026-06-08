export type NoteMeta = {
  path: string;
  title: string;
  tags: string[];
  frontmatter: Record<string, string>;
  modifiedAt?: string;
  contentHash: string;
};

export type NoteLink = {
  sourcePath: string;
  targetRef: string;
  resolvedPath: string | null;
  line: number;
  isManaged: boolean;
};

export type ParsedNote = NoteMeta & {
  content: string;
  links: NoteLink[];
};

export type SearchFilters = {
  query: string;
  tags?: string[];
  frontmatter?: Record<string, string>;
};

export type SearchResult = NoteMeta & {
  snippet: string;
};

export type NoteContext = {
  note: ParsedNote;
  backlinks: NoteLink[];
  outgoingLinks: NoteLink[];
};

export type GraphNode = {
  id: string;
  label: string;
  tags: string[];
  kind?: "note" | "unresolved";
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  isManaged: boolean;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  focusedPath: string | null;
};

export type VaultFile = {
  path: string;
  content: string;
  modifiedAt?: string;
};

export type VaultIndex = {
  notes: ParsedNote[];
  graph: GraphData;
};
