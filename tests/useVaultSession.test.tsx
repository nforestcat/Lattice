import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultApi } from "../src/api";
import type { LlmConfig, NoteDocument, VaultConfig, VaultSnapshot } from "../src/api/types";
import type { NoteContext, NoteMeta } from "../src/core/types";
import { PRESETS } from "../src/ui/hooks/contextShared";
import { useVaultSession, type UseVaultSessionParams } from "../src/ui/hooks/useVaultSession";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolveDeferred: Deferred<T>["resolve"] | undefined;
  let rejectDeferred: Deferred<T>["reject"] | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  if (!resolveDeferred || !rejectDeferred) {
    throw new Error("Deferred promise callbacks were not initialized.");
  }
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

function noteMeta(path: string): NoteMeta {
  return {
    path,
    title: path.replace(/\.md$/, ""),
    tags: [],
    frontmatter: {},
    contentHash: path,
  };
}

function vaultSnapshot(rootPath: string, notePath: string): VaultSnapshot {
  return {
    rootPath,
    notes: [noteMeta(notePath)],
    tree: [],
  };
}

function noteDocument(path: string): NoteDocument {
  return {
    path,
    content: `# ${path}`,
    revision: `${path}-revision`,
  };
}

function noteContext(path: string): NoteContext {
  return {
    note: {
      ...noteMeta(path),
      content: "",
      links: [],
    },
    backlinks: [],
    outgoingLinks: [],
  };
}

function baseParams(): UseVaultSessionParams {
  const vaultConfigRef: MutableRefObject<VaultConfig> = { current: {} };
  const llmConfig: LlmConfig = { provider: "openai", apiKey: "", model: "gpt-4o" };
  return {
    vault: null,
    setVault: vi.fn(),
    activePath: null,
    setActivePath: vi.fn(),
    document: null,
    setDocument: vi.fn(),
    draft: "",
    setDraft: vi.fn(),
    setViewMode: vi.fn(),
    setStatus: vi.fn(),
    vaultConfig: {},
    setVaultConfig: vi.fn(),
    vaultConfigRef,
    updateVaultConfig: vi.fn().mockResolvedValue(undefined),
    setContext: vi.fn(),
    setSnapshots: vi.fn(),
    runHealthAudit: vi.fn(),
    setContextBundle: vi.fn(),
    setContextCandidates: vi.fn(),
    setSelectedContextPaths: vi.fn(),
    setBundlePreset: vi.fn(),
    setBundlePurpose: vi.fn(),
    setBundleMode: vi.fn(),
    setContextLimit: vi.fn(),
    PRESETS,
    llmConfig,
    setLlmConfig: vi.fn(),
    setMetadataSuggestions: vi.fn(),
    setEmbeddingsCache: vi.fn(),
    setResults: vi.fn(),
    setGitStatus: vi.fn(),
    setGitChanges: vi.fn(),
    setSelectedGitFile: vi.fn(),
    setActiveDiff: vi.fn(),
    setCommitMessage: vi.fn(),
    setGitOutputLog: vi.fn(),
    updateLinkSuggestions: vi.fn(),
    updateSemanticRecommendations: vi.fn(),
    refreshBacklinkSuggestions: vi.fn(),
    setInboxCaptures: vi.fn(),
    pruneExpiredPromptRuns: vi.fn(),
    setActiveUnresolvedTarget: vi.fn(),
    setGraph: vi.fn(),
    setIsCustomLimit: vi.fn(),
    setPromptInstruction: vi.fn(),
    setArchiveStatus: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useVaultSession openVault startup races", () => {
  it("ignores an older open when it resolves after a newer vault", async () => {
    // Given
    const slowOpen = deferred<VaultSnapshot>();
    const fastOpen = deferred<VaultSnapshot>();
    const slowVault = vaultSnapshot("Slow Vault", "Slow.md");
    const fastVault = vaultSnapshot("Fast Vault", "Fast.md");
    const pendingVaults = new Map<string, Deferred<VaultSnapshot>>([
      ["slow", slowOpen],
      ["fast", fastOpen],
    ]);
    vi.spyOn(vaultApi, "openVault").mockImplementation((path) => {
      const pending = pendingVaults.get(path);
      if (!pending) {
        throw new Error(`Unexpected vault path: ${path}`);
      }
      return pending.promise;
    });
    vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({});
    vi.spyOn(vaultApi, "loadEmbeddingsCache").mockResolvedValue("");
    vi.spyOn(vaultApi, "readNote").mockImplementation(async (path) => noteDocument(path));
    vi.spyOn(vaultApi, "getNoteContext").mockImplementation(async (path) => noteContext(path));
    vi.spyOn(vaultApi, "listSnapshots").mockResolvedValue([]);
    vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([]);
    vi.spyOn(vaultApi, "getInboxCaptures").mockResolvedValue([]);
    vi.spyOn(vaultApi, "getGraph").mockResolvedValue({ nodes: [], edges: [], focusedPath: null });
    vi.spyOn(vaultApi, "getGitStatus").mockResolvedValue({
      isRepo: false,
      autoGitEnabled: false,
      branch: null,
      hasChanges: false,
      hasConflicts: false,
    });
    vi.spyOn(vaultApi, "getArchiveStatus").mockResolvedValue({ fileCount: 0, totalBytes: 0 });
    const params = baseParams();
    const { result } = renderHook(() => useVaultSession(params));
    const operations: {
      slow: Promise<void> | null;
      fast: Promise<void> | null;
    } = { slow: null, fast: null };

    // When
    act(() => {
      operations.slow = result.current.openVault("slow");
    });
    act(() => {
      operations.fast = result.current.openVault("fast");
    });
    if (!operations.slow || !operations.fast) {
      throw new Error("Open vault operations were not started.");
    }
    await act(async () => {
      fastOpen.resolve(fastVault);
      await operations.fast;
    });
    await act(async () => {
      slowOpen.resolve(slowVault);
      await operations.slow;
    });

    // Then
    expect(params.setVault).toHaveBeenCalledTimes(1);
    expect(params.setVault).toHaveBeenCalledWith(fastVault);
    expect(params.setStatus).toHaveBeenCalledWith("Opened Fast Vault");
    expect(params.setStatus).not.toHaveBeenCalledWith("Opened Slow Vault");
    expect(params.setActivePath).toHaveBeenCalledWith("Fast.md");
    expect(params.setActivePath).not.toHaveBeenCalledWith("Slow.md");
    expect(params.setDocument).toHaveBeenCalledWith(noteDocument("Fast.md"));
    expect(params.setDocument).not.toHaveBeenCalledWith(noteDocument("Slow.md"));
  });
});
