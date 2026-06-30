import { describe, expect, it, vi } from "vitest";
import { loadNoteContext, loadVaultOverview } from "../src/ui/contextRefresh";
import type { ContextBundleCandidate, GitStatus, Snapshot, VaultApi } from "../src/api/types";
import type { NoteContext, GraphData } from "../src/core/types";

type TestApi = Pick<
  VaultApi,
  "getContextBundleCandidates" | "getGitStatus" | "getGraph" | "getInboxCaptures" | "getNoteContext" | "listSnapshots"
>;

const noteContext: NoteContext = {
  note: {
    path: "Projects/Obsidian Replacement.md",
    title: "Obsidian Replacement",
    content: "Build a local-first Markdown app",
    tags: [],
    frontmatter: {},
    links: [],
    modifiedAt: "2026-06-19T00:00:00.000Z",
    contentHash: "context-refresh-test",
  },
  backlinks: [],
  outgoingLinks: [],
};

const graph: GraphData = { nodes: [], edges: [], focusedPath: null };
const gitStatus: GitStatus = {
  isRepo: true,
  autoGitEnabled: false,
  branch: "main",
  hasChanges: false,
  hasConflicts: false,
};
const snapshots: Snapshot[] = [];
const candidates: ContextBundleCandidate[] = [];

function createApi(): TestApi {
  return {
    getContextBundleCandidates: vi.fn().mockResolvedValue(candidates),
    getGitStatus: vi.fn().mockResolvedValue(gitStatus),
    getGraph: vi.fn().mockResolvedValue(graph),
    getInboxCaptures: vi.fn().mockResolvedValue([]),
    getNoteContext: vi.fn().mockResolvedValue(noteContext),
    listSnapshots: vi.fn().mockResolvedValue(snapshots),
  };
}

describe("note context refresh", () => {
  it("does not reload graph or git status when only the selected note changes", async () => {
    const api = createApi();

    await loadNoteContext(api, "Projects/Obsidian Replacement.md", false);

    expect(api.getNoteContext).toHaveBeenCalledWith("Projects/Obsidian Replacement.md");
    expect(api.listSnapshots).toHaveBeenCalledWith("Projects/Obsidian Replacement.md");
    expect(api.getContextBundleCandidates).toHaveBeenCalledWith("Projects/Obsidian Replacement.md");
    expect(api.getInboxCaptures).not.toHaveBeenCalled();
    expect(api.getGraph).not.toHaveBeenCalled();
    expect(api.getGitStatus).not.toHaveBeenCalled();
  });

  it("starts note-specific context requests in parallel", async () => {
    const api = createApi();
    let resolveContext: ((value: NoteContext) => void) | undefined;
    const pendingContext = new Promise<NoteContext>((resolve) => {
      resolveContext = resolve;
    });
    vi.mocked(api.getNoteContext).mockReturnValueOnce(pendingContext);

    const result = loadNoteContext(api, "Projects/Obsidian Replacement.md", true);

    expect(api.getNoteContext).toHaveBeenCalledWith("Projects/Obsidian Replacement.md");
    expect(api.listSnapshots).toHaveBeenCalledWith("Projects/Obsidian Replacement.md");
    expect(api.getContextBundleCandidates).toHaveBeenCalledWith("Projects/Obsidian Replacement.md");
    expect(api.getInboxCaptures).toHaveBeenCalledWith("Projects/Obsidian Replacement.md");

    resolveContext?.(noteContext);
    await expect(result).resolves.toEqual({
      context: noteContext,
      snapshots,
      candidates,
      inboxCaptures: [],
    });
  });

  it("loads the vault overview independently from note context", async () => {
    const api = createApi();

    await expect(loadVaultOverview(api)).resolves.toEqual({ graph, gitStatus });

    expect(api.getGraph).toHaveBeenCalled();
    expect(api.getGitStatus).toHaveBeenCalled();
    expect(api.getNoteContext).not.toHaveBeenCalled();
    expect(api.listSnapshots).not.toHaveBeenCalled();
    expect(api.getContextBundleCandidates).not.toHaveBeenCalled();
  });
});
