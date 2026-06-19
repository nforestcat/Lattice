import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultApi } from "../src/api";
import { App } from "../src/ui/App";

vi.mock("@uiw/react-codemirror", () => ({
  default: () => <textarea data-testid="mock-editor" />,
}));

const originalFetch = window.fetch;

describe("note context refresh", () => {
  beforeEach(() => {
    window.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ embedding: [0.9, 0.8, 0.7] }],
      embedding: [0.9, 0.8, 0.7],
      models: [],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  });

  afterEach(() => {
    window.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("does not reload graph or git status when only the selected note changes", async () => {
    // Given
    const graphSpy = vi.spyOn(vaultApi, "getGraph");
    const gitStatusSpy = vi.spyOn(vaultApi, "getGitStatus");
    const backlinkSpy = vi.spyOn(vaultApi, "getBacklinkSuggestions");
    render(<App />);
    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    await waitFor(() => expect(graphSpy).toHaveBeenCalled());
    await waitFor(() => expect(gitStatusSpy).toHaveBeenCalled());
    graphSpy.mockClear();
    gitStatusSpy.mockClear();
    backlinkSpy.mockClear();

    // When
    fireEvent.click(screen.getByText("Obsidian Replacement.md"));
    await waitFor(() => expect(backlinkSpy).toHaveBeenCalledWith("Projects/Obsidian Replacement.md"));

    // Then
    expect(graphSpy).not.toHaveBeenCalled();
    expect(gitStatusSpy).not.toHaveBeenCalled();
  });

  it("starts note-specific context requests in parallel", async () => {
    // Given
    const contextSpy = vi.spyOn(vaultApi, "getNoteContext");
    const snapshotsSpy = vi.spyOn(vaultApi, "listSnapshots");
    const candidatesSpy = vi.spyOn(vaultApi, "getContextBundleCandidates");
    render(<App />);
    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    let resolveContext: (() => void) | undefined;
    const pendingContext = new Promise<Awaited<ReturnType<typeof vaultApi.getNoteContext>>>((resolve) => {
      resolveContext = () => resolve({
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
      });
    });
    contextSpy.mockImplementationOnce(() => pendingContext);
    contextSpy.mockClear();
    snapshotsSpy.mockClear();
    candidatesSpy.mockClear();

    // When
    fireEvent.click(screen.getByText("Obsidian Replacement.md"));
    await waitFor(() => expect(contextSpy).toHaveBeenCalledWith("Projects/Obsidian Replacement.md"));

    // Then
    expect(snapshotsSpy).toHaveBeenCalledWith("Projects/Obsidian Replacement.md");
    expect(candidatesSpy).toHaveBeenCalledWith("Projects/Obsidian Replacement.md");

    const completeContext = resolveContext;
    if (completeContext) {
      await act(async () => {
        completeContext();
        await pendingContext;
      });
    }
  });
});
