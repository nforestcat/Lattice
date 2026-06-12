import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, normalizeVaultConfig } from "../src/ui/App";
import { vaultApi } from "../src/api";
import * as llmApi from "../src/api/llm";

vi.mock("@uiw/react-codemirror", () => {
  return {
    default: (props: any) => {
      if (props.ref && typeof props.ref === "object") {
        props.ref.current = {
          view: {
            get state() {
              const editor = document.querySelector("[data-testid='mock-editor']") as HTMLTextAreaElement | null;
              const from = editor?.selectionStart ?? (props.value || "").length;
              const to = editor?.selectionEnd ?? from;
              return {
                selection: { main: { from, to } },
                update: (transaction: any) => transaction
              };
            },
            dispatch: (transaction: any) => {
              const value = props.value || "";
              const { from, to, insert } = transaction.changes;
              const nextValue = `${value.slice(0, from)}${insert}${value.slice(to)}`;
              props.onChange?.(nextValue);
            },
            focus: () => {}
          }
        };
      }
      return (
        <textarea
          data-testid="mock-editor"
          className="mock-editor"
          value={props.value || ""}
          onChange={(e) => props.onChange && props.onChange(e.target.value)}
          style={{ width: "100%", height: "100%" }}
        />
      );
    }
  };
});

const originalFetch = window.fetch;

describe("App layout", () => {
  beforeEach(() => {
    window.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.9, 0.8, 0.7] }],
        embedding: [0.9, 0.8, 0.7],
        models: []
      }),
      text: async () => ""
    } as Response);
  });

  afterEach(() => {
    window.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("starts in split mode with editor and preview visible together", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    expect(screen.getByRole("button", { name: "Split" }).className).toContain("active");
    expect(document.querySelector(".editorSurface")).toBeTruthy();
    expect(document.querySelector(".previewSurface")?.textContent).toContain("Welcome to Lattice.");
  });

  it("uses model-agnostic context limit labels", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    expect(screen.getByRole("option", { name: "Small - 8K" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Medium - 32K" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Large - 128K" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Huge - 200K" })).toBeTruthy();
    expect(screen.queryByText(/GPT|Claude|Ollama/)).toBeNull();
  });

  it("shows imported Obsidian settings when the opened vault has them", async () => {
    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [],
      tree: [],
      obsidianSettings: {
        detected: true,
        readableLineLength: true,
        theme: "obsidian",
        accentColor: "#7c3aed",
        enabledCorePlugins: ["backlink", "graph"]
      }
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Imported Obsidian settings")).toBeTruthy());

    openVaultSpy.mockRestore();
  });

  it("asks for confirmation before deleting a note from the file tree", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const deleteSpy = vi.spyOn(vaultApi, "deleteEntry");

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    fireEvent.click(screen.getByTitle("Delete Home.md"));

    expect(confirmSpy).toHaveBeenCalledWith('Delete note "Home.md"?');
    expect(deleteSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
    deleteSpy.mockRestore();
  });

  it("asks for confirmation before removing a managed graph link", async () => {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const deleteLinkSpy = vi.spyOn(vaultApi, "deleteManagedGraphLink");

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));

    const removeSelect = Array.from(document.querySelectorAll("select")).find((select) => {
      return select.querySelector("option")?.textContent === "Remove managed link";
    }) as HTMLSelectElement | undefined;
    expect(removeSelect).toBeTruthy();

    fireEvent.change(removeSelect!, { target: { value: "Projects/Obsidian Replacement.md" } });

    expect(confirmSpy).toHaveBeenCalledWith('Remove managed graph link to "Projects/Obsidian Replacement.md"?');
    expect(deleteLinkSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
    deleteLinkSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("handles token limit config overflows and auto-prunes lowest score recommended notes", async () => {
    // Stub getContextBundleCandidates to return controlled focus and recommended notes
    const candidatesSpy = vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 50, selected: true, characterCount: 100 },
      { path: "Rec1.md", title: "Rec1", reason: "Recommended", reasonDetail: "Rec1 detail", score: 5, excerpt: "Rec1 excerpt", tokenEstimate: 30, selected: false, characterCount: 60 },
      { path: "Rec2.md", title: "Rec2", reason: "Recommended", reasonDetail: "Rec2 detail", score: 7, excerpt: "Rec2 excerpt", tokenEstimate: 40, selected: false, characterCount: 80 }
    ]);

    const bundleSpy = vi.spyOn(vaultApi, "getContextBundle").mockImplementation(async (path, options) => {
      const selected = options?.selectedPaths || [];
      let tokens = 0;
      if (selected.includes("Home.md")) tokens += 50;
      if (selected.includes("Rec1.md")) tokens += 30;
      if (selected.includes("Rec2.md")) tokens += 40;
      return {
        title: "Context Bundle: Home",
        focusPath: "Home.md",
        notePaths: selected,
        markdown: "Bundle Content",
        estimatedTokens: tokens
      };
    });

    render(<App />);

    // Wait for the app to load and refresh context on the active note Home.md
    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Rec1")).toBeTruthy());

    // Check Rec1 and Rec2 checkboxes to select them
    const rec1Checkbox = screen.getByLabelText("Rec1") as HTMLInputElement;
    const rec2Checkbox = screen.getByLabelText("Rec2") as HTMLInputElement;
    
    // Check current state: only Home is selected (50 tokens), wait for state flush
    await waitFor(() => expect(screen.getByText(/50 \/ [\d,]+ tokens/)).toBeTruthy());

    fireEvent.click(rec1Checkbox);
    fireEvent.click(rec2Checkbox);

    // Selected total should now be 50 + 30 + 40 = 120 tokens
    await waitFor(() => expect(screen.getByText(/120 \/ [\d,]+ tokens/)).toBeTruthy());

    // Switch limit selection to custom limit and set it to 100
    const limitSelect = screen.getByLabelText("Limit") as HTMLSelectElement;
    fireEvent.change(limitSelect, { target: { value: "custom" } });

    const customLimitInput = screen.getByPlaceholderText("Tokens...") as HTMLInputElement;
    fireEvent.change(customLimitInput, { target: { value: "100" } });

    // Warning should show up: Exceeded limit by 20 tokens (120 - 100)
    await waitFor(() => expect(screen.getByText(/Exceeded target limit by 20 tokens/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Auto-prune Recommended" })).toBeTruthy();

    // Click Auto-prune Recommended
    const pruneBtn = screen.getByRole("button", { name: "Auto-prune Recommended" });
    fireEvent.click(pruneBtn);

    // Total tokens should drop to 90 (120 - 30) because Rec1 (score 5) got pruned, while Rec2 (score 7) remains selected.
    await waitFor(() => expect(screen.getByText(/90 \/ 100 tokens/)).toBeTruthy());

    
    // Rec1 should be unchecked, Rec2 should be checked
    expect(rec1Checkbox.checked).toBe(false);
    expect(rec2Checkbox.checked).toBe(true);

    // Warning should be gone
    expect(screen.queryByText(/Exceeded target limit/)).toBeNull();

    candidatesSpy.mockRestore();
    bundleSpy.mockRestore();
  });

  it("reports when auto-pruning cannot bring the actual bundle under the limit", async () => {
    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({});
    const saveVaultConfigSpy = vi.spyOn(vaultApi, "saveVaultConfig").mockResolvedValue();
    const candidatesSpy = vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 120, selected: true, characterCount: 240 },
      { path: "Rec1.md", title: "Rec1", reason: "Recommended", reasonDetail: "Rec1 detail", score: 5, excerpt: "Rec1 excerpt", tokenEstimate: 30, selected: true, characterCount: 60 }
    ]);

    const bundleSpy = vi.spyOn(vaultApi, "getContextBundle").mockImplementation(async (_path, options) => {
      const selected = options?.selectedPaths || [];
      return {
        title: "Context Bundle: Home",
        focusPath: "Home.md",
        notePaths: selected,
        markdown: "Bundle Content",
        estimatedTokens: selected.includes("Rec1.md") ? 160 : 130
      };
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Rec1")).toBeTruthy());

    const limitSelect = screen.getByLabelText("Limit") as HTMLSelectElement;
    fireEvent.change(limitSelect, { target: { value: "custom" } });
    fireEvent.change(screen.getByPlaceholderText("Tokens..."), { target: { value: "100" } });

    await waitFor(() => expect(screen.getByRole("button", { name: "Auto-prune Recommended" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Auto-prune Recommended" }));

    await waitFor(() => {
      expect(screen.getByText(/bundle still exceeds the limit \(Final: 130 tokens\)/)).toBeTruthy();
    });

    getVaultConfigSpy.mockRestore();
    saveVaultConfigSpy.mockRestore();
    candidatesSpy.mockRestore();
    bundleSpy.mockRestore();
  });

  it("regenerates with the derived preset when switching an existing bundle to Short mode", async () => {
    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({});
    const saveVaultConfigSpy = vi.spyOn(vaultApi, "saveVaultConfig").mockResolvedValue();
    const candidatesSpy = vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 50, selected: true, characterCount: 100 }
    ]);

    const bundleSpy = vi.spyOn(vaultApi, "getContextBundle").mockResolvedValue({
      title: "Context Bundle: Home",
      focusPath: "Home.md",
      notePaths: ["Home.md"],
      markdown: "Bundle Content",
      estimatedTokens: 150
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Limit"), { target: { value: "custom" } });
    fireEvent.change(screen.getByPlaceholderText("Tokens..."), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate bundle" }));

    await waitFor(() => expect(screen.getByText("Prompt Workspace")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Switch to Short Mode" }));

    await waitFor(() => {
      expect(bundleSpy).toHaveBeenLastCalledWith("Home.md", expect.objectContaining({
        mode: "short",
        preset: "custom"
      }));
    });

    getVaultConfigSpy.mockRestore();
    saveVaultConfigSpy.mockRestore();
    candidatesSpy.mockRestore();
    bundleSpy.mockRestore();
  });

  it("allows sorting candidates by score/title and filtering by connection type", async () => {
    const candidatesSpy = vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 50, selected: true, characterCount: 100 },
      { path: "RecB.md", title: "RecB", reason: "Recommended", reasonDetail: "RecB detail", score: 8, excerpt: "RecB excerpt", tokenEstimate: 30, selected: false, characterCount: 60 },
      { path: "RecA.md", title: "RecA", reason: "Recommended", reasonDetail: "RecA detail", score: 5, excerpt: "RecA excerpt", tokenEstimate: 40, selected: false, characterCount: 80 }
    ]);

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("RecB")).toBeTruthy());

    const getCandidateTitles = () => {
      const listEl = document.querySelector(".candidateList");
      if (!listEl) return [];
      const labels = listEl.querySelectorAll(".candidateLabel");
      return Array.from(labels).map(el => el.textContent?.trim() || "");
    };

    // By default, sorting is by Score (descending) -> Home (10), RecB (8), RecA (5)
    expect(getCandidateTitles()).toEqual(["Home", "RecB", "RecA"]);

    // Change filter to Recommended only
    const filterSelect = screen.getByLabelText("Filter") as HTMLSelectElement;
    fireEvent.change(filterSelect, { target: { value: "recommended" } });

    // Verify Home is no longer rendered in candidate list, only RecB and RecA remain
    await waitFor(() => expect(getCandidateTitles()).toEqual(["RecB", "RecA"]));

    // Change sort to Title (ascending) -> RecA, RecB
    const sortSelect = screen.getByLabelText("Sort") as HTMLSelectElement;
    fireEvent.change(sortSelect, { target: { value: "title" } });

    // Verify titles sequence is RecA, RecB
    await waitFor(() => expect(getCandidateTitles()).toEqual(["RecA", "RecB"]));

    candidatesSpy.mockRestore();
  });

  it("loads and saves settings (limit, mode, purpose, selected candidates) from vault config", async () => {
    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      contextLimit: 120,
      bundleMode: "short",
      bundlePurpose: "Write a summary",
      bundlePreset: "custom",
      selectedPaths: {
        "Home.md": ["Rec1.md"]
      }
    });
    const saveVaultConfigSpy = vi.spyOn(vaultApi, "saveVaultConfig").mockResolvedValue();

    const candidatesSpy = vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 50, selected: true, characterCount: 100 },
      { path: "Rec1.md", title: "Rec1", reason: "Recommended", reasonDetail: "Rec1 detail", score: 5, excerpt: "Rec1 excerpt", tokenEstimate: 30, selected: false, characterCount: 60 }
    ]);

    render(<App />);

    // Wait for the app to load
    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    // Verify loaded inputs match the configured stub
    const limitSelect = screen.getByLabelText("Limit") as HTMLSelectElement;
    await waitFor(() => expect(limitSelect.value).toBe("custom"));
    const customLimitInput = screen.getByPlaceholderText("Tokens...") as HTMLInputElement;
    expect(customLimitInput.value).toBe("120");

    const modeSelect = screen.getByLabelText("Mode") as HTMLSelectElement;
    expect(modeSelect.value).toBe("short");

    const purposeInput = screen.getByPlaceholderText("e.g. Summarize or refactor...") as HTMLInputElement;
    expect(purposeInput.value).toBe("Write a summary");

    // Rec1 should be checked because it's listed in getVaultConfig under selectedPaths["Home.md"]
    const rec1Checkbox = screen.getByLabelText("Rec1") as HTMLInputElement;
    await waitFor(() => expect(rec1Checkbox.checked).toBe(true));

    // Verify toggling candidate calls saveVaultConfig
    fireEvent.click(rec1Checkbox);
    expect(rec1Checkbox.checked).toBe(false);
    expect(saveVaultConfigSpy).toHaveBeenCalled();

    getVaultConfigSpy.mockRestore();
    saveVaultConfigSpy.mockRestore();
    candidatesSpy.mockRestore();
  });

  it("saves preset, purpose, and mode changes as consistent config updates", async () => {
    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      contextLimit: 8000,
      bundleMode: "standard",
      bundlePurpose: "Answer questions based on the provided wiki context.",
      bundlePreset: "ask"
    });
    const saveVaultConfigSpy = vi.spyOn(vaultApi, "saveVaultConfig").mockResolvedValue();

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    await waitFor(() => expect(screen.getByLabelText("Preset")).toBeTruthy());
    saveVaultConfigSpy.mockClear();

    const purposeInput = screen.getByPlaceholderText("e.g. Summarize or refactor...") as HTMLInputElement;
    fireEvent.change(purposeInput, { target: { value: "Write a Korean summary." } });

    await waitFor(() => {
      expect(saveVaultConfigSpy).toHaveBeenLastCalledWith(expect.objectContaining({
        bundlePreset: "custom",
        bundlePurpose: "Write a Korean summary.",
        bundleMode: "standard"
      }));
    });

    const modeSelect = screen.getByLabelText("Mode") as HTMLSelectElement;
    fireEvent.change(modeSelect, { target: { value: "short" } });

    await waitFor(() => {
      expect(saveVaultConfigSpy).toHaveBeenLastCalledWith(expect.objectContaining({
        bundlePreset: "custom",
        bundlePurpose: "Write a Korean summary.",
        bundleMode: "short"
      }));
    });

    getVaultConfigSpy.mockRestore();
    saveVaultConfigSpy.mockRestore();
  });

  it("loads prompt instructions from config and saves edited prompt instructions in Prompt Workspace", async () => {
    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      contextLimit: 8000,
      bundleMode: "standard",
      bundlePurpose: "Answer questions based on the provided wiki context.",
      bundlePreset: "ask",
      promptInstructions: {
        "Home.md": "Draft instructions for Home"
      }
    });
    const saveVaultConfigSpy = vi.spyOn(vaultApi, "saveVaultConfig").mockResolvedValue();

    const candidatesSpy = vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 50, selected: true, characterCount: 100 }
    ]);
    const bundleSpy = vi.spyOn(vaultApi, "getContextBundle").mockResolvedValue({
      title: "Context Bundle: Home",
      focusPath: "Home.md",
      notePaths: ["Home.md"],
      markdown: "Bundle Content",
      estimatedTokens: 50
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    
    // Click Generate Bundle
    const generateBtn = screen.getByRole("button", { name: "Generate bundle" });
    fireEvent.click(generateBtn);

    // Verify Prompt Workspace is rendered and has the loaded instruction
    await waitFor(() => expect(screen.getByText("Prompt Workspace")).toBeTruthy());
    const promptTextarea = screen.getByPlaceholderText("Ask a question or specify the task for the LLM...") as HTMLTextAreaElement;
    expect(promptTextarea.value).toBe("Draft instructions for Home");

    // Edit the prompt instruction
    saveVaultConfigSpy.mockClear();
    fireEvent.change(promptTextarea, { target: { value: "Updated draft" } });

    await waitFor(() => {
      expect(saveVaultConfigSpy).toHaveBeenLastCalledWith(expect.objectContaining({
        promptInstructions: expect.objectContaining({
          "Home.md": "Updated draft"
        })
      }));
    });

    getVaultConfigSpy.mockRestore();
    saveVaultConfigSpy.mockRestore();
    candidatesSpy.mockRestore();
    bundleSpy.mockRestore();
  });

  it("renders prompt runs history and handles Load/Copy actions", async () => {
    // Mock navigator.clipboard
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: writeTextMock
      },
      writable: true,
      configurable: true
    });

    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      contextLimit: 8000,
      bundleMode: "standard",
      bundlePreset: "ask",
      promptRuns: [
        {
          id: "run-123",
          question: "Summarize this vault",
          selectedNotes: ["Home.md"],
          preset: "ask",
          purpose: "Summarize this vault for a follow-up LLM prompt.",
          mode: "standard",
          tokenCount: 150,
          createdAt: "2026-06-05T14:00:00.000Z",
          activePath: "Home.md"
        }
      ]
    });
    const saveVaultConfigSpy = vi.spyOn(vaultApi, "saveVaultConfig").mockResolvedValue();
    const candidatesSpy = vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 50, selected: true, characterCount: 100 }
    ]);
    const bundleSpy = vi.spyOn(vaultApi, "getContextBundle").mockResolvedValue({
      title: "Context Bundle: Home",
      focusPath: "Home.md",
      notePaths: ["Home.md"],
      markdown: "Bundle Content",
      estimatedTokens: 50
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Prompt History")).toBeTruthy());
    expect(screen.getByText("Summarize this vault")).toBeTruthy();
    expect(screen.getByText("ask / standard")).toBeTruthy();
    expect(screen.getByText("150 tokens")).toBeTruthy();

    // Verify copy question works
    const copyBtn = screen.getByRole("button", { name: "Copy Question" });
    fireEvent.click(copyBtn);
    expect(writeTextMock).toHaveBeenCalledWith("Summarize this vault");

    // Click Load
    const loadBtn = screen.getByRole("button", { name: "Load" });
    fireEvent.click(loadBtn);

    await waitFor(() => {
      expect(saveVaultConfigSpy).toHaveBeenCalled();
    });
    expect(saveVaultConfigSpy).toHaveBeenCalledWith(expect.objectContaining({
      version: 1,
      bundlePurpose: "Summarize this vault for a follow-up LLM prompt."
    }));
    expect(bundleSpy).toHaveBeenCalledWith("Home.md", expect.objectContaining({
      purpose: "Summarize this vault for a follow-up LLM prompt."
    }));

    getVaultConfigSpy.mockRestore();
    saveVaultConfigSpy.mockRestore();
    candidatesSpy.mockRestore();
    bundleSpy.mockRestore();
  });

  it("manages prompt templates and shows bundle audit breakdown and changes diff", async () => {
    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      contextLimit: 8000,
      bundleMode: "standard",
      bundlePreset: "ask",
      promptTemplates: [
        { id: "custom-1", name: "Custom Tmpl", template: "My custom instructions", isSystem: false }
      ]
    });
    const saveVaultConfigSpy = vi.spyOn(vaultApi, "saveVaultConfig").mockResolvedValue();
    const candidatesSpy = vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 50, selected: true, characterCount: 100 },
      { path: "Project.md", title: "Project", reason: "Recommended", reasonDetail: "Mentions focus", score: 8, excerpt: "Project details", tokenEstimate: 40, selected: true, characterCount: 80 }
    ]);
    
    let callCount = 0;
    const bundleSpy = vi.spyOn(vaultApi, "getContextBundle").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          title: "Context Bundle: Home",
          focusPath: "Home.md",
          notePaths: ["Home.md"],
          markdown: "Bundle Content 1",
          estimatedTokens: 50
        };
      } else {
        return {
          title: "Context Bundle: Home",
          focusPath: "Home.md",
          notePaths: ["Home.md", "Project.md"],
          markdown: "Bundle Content 2",
          estimatedTokens: 90
        };
      }
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    
    const generateBtn = screen.getByRole("button", { name: "Generate bundle" });
    fireEvent.click(generateBtn);

    await waitFor(() => expect(screen.getByText("Prompt Workspace")).toBeTruthy());

    expect(screen.getByText("Templates ▾")).toBeTruthy();
    
    fireEvent.click(screen.getByText("Templates ▾"));
    expect(screen.getByText("System Templates")).toBeTruthy();
    expect(screen.getByText("Custom Templates")).toBeTruthy();
    expect(screen.getByText("Custom Tmpl")).toBeTruthy();

    fireEvent.click(screen.getByText("Custom Tmpl"));
    const promptTextarea = screen.getByPlaceholderText("Ask a question or specify the task for the LLM...") as HTMLTextAreaElement;
    expect(promptTextarea.value).toBe("My custom instructions");

    expect(screen.getByText("🔍 Context Bundle Audit & Diff")).toBeTruthy();
    fireEvent.click(screen.getByText("🔍 Context Bundle Audit & Diff"));
    
    expect(screen.getAllByText("Focus").length).toBeGreaterThan(0);
    expect(screen.getByText("This is the active note of your workspace.")).toBeTruthy();

    fireEvent.click(generateBtn);

    await waitFor(() => expect(screen.getByText("+40 tokens")).toBeTruthy());
    expect(screen.getByText("+Project.md")).toBeTruthy();

    getVaultConfigSpy.mockRestore();
    saveVaultConfigSpy.mockRestore();
    candidatesSpy.mockRestore();
    bundleSpy.mockRestore();
  });

  it("normalizes malformed or empty vault configs using normalizeVaultConfig", () => {
    const emptyConfig = normalizeVaultConfig(null);
    expect(emptyConfig.version).toBe(1);
    expect(emptyConfig.contextLimit).toBe(8000);
    expect(emptyConfig.promptRuns).toEqual([]);
    
    const partialConfig = normalizeVaultConfig({ contextLimit: 32000, promptRuns: null });
    expect(partialConfig.contextLimit).toBe(32000);
    expect(partialConfig.promptRuns).toEqual([]);

    const migratedConfig = normalizeVaultConfig({
      version: 0,
      bundlePreset: "review",
      selectedPaths: {
        "Home.md": ["Home.md", 42, null]
      },
      promptInstructions: {
        "Home.md": "Review this",
        "Broken.md": 123
      },
      promptRuns: [
        {
          id: "legacy-run",
          question: "Review this vault",
          selectedNotes: ["Home.md", false],
          preset: "review",
          mode: "invalid",
          tokenCount: -5,
          createdAt: "2026-06-05T14:00:00.000Z",
          activePath: "Home.md"
        }
      ],
      promptTemplates: [
        { id: "ok", name: "OK", template: "Template {active_note}" },
        { id: "bad", name: 123, template: null }
      ],
      llmConfig: {
        provider: "openai",
        apiKey: "sk-should-not-be-stored",
        model: "gpt-4o",
        embeddingProvider: "local-onnx"
      }
    });
    expect(migratedConfig.version).toBe(1);
    expect(migratedConfig.selectedPaths?.["Home.md"]).toEqual(["Home.md"]);
    expect(migratedConfig.promptInstructions).toEqual({ "Home.md": "Review this" });
    expect(migratedConfig.promptRuns?.[0]).toEqual(expect.objectContaining({
      purpose: "Review code structure, propose refactorings, or suggest quality improvements.",
      mode: "full",
      tokenCount: 0,
      selectedNotes: ["Home.md"]
    }));
    expect(migratedConfig.promptTemplates).toEqual([
      { id: "ok", name: "OK", template: "Template {active_note}", isSystem: false }
    ]);
    expect(migratedConfig.llmConfig).toEqual(expect.objectContaining({
      provider: "openai",
      apiKey: "",
      model: "gpt-4o",
      embeddingProvider: "local-onnx"
    }));
  });

  it("keeps LLM API keys out of vault config when saving settings", async () => {
    window.localStorage.clear();
    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      llmConfig: { provider: "openai", apiKey: "", model: "gpt-4o" }
    });
    const saveVaultConfigSpy = vi.spyOn(vaultApi, "saveVaultConfig").mockResolvedValue();

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Distill" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat with LLM" }));
    fireEvent.click(screen.getByRole("button", { name: /LLM Settings/ }));

    const apiKeyInput = screen.getByPlaceholderText("Enter API Key");
    fireEvent.change(apiKeyInput, { target: { value: "sk-live-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => {
      expect(saveVaultConfigSpy).toHaveBeenCalledWith(expect.objectContaining({
        llmConfig: expect.objectContaining({
          provider: "openai",
          apiKey: "",
          model: "gpt-4o"
        })
      }));
    });
    expect(window.localStorage.getItem("lattice:llm-api-key:openai")).toBe("sk-live-secret");

    getVaultConfigSpy.mockRestore();
    saveVaultConfigSpy.mockRestore();
    window.localStorage.clear();
  });

  it("prefills a usable default OpenAI model when no LLM config is saved", async () => {
    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({});

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Distill" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat with LLM" }));
    fireEvent.click(screen.getByRole("button", { name: /LLM Settings/ }));

    expect(screen.getByDisplayValue("gpt-4o")).toBeTruthy();

    getVaultConfigSpy.mockRestore();
  });

  it("compiles template variables properly when template is selected", async () => {
    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      promptTemplates: [
        { id: "custom-var", name: "Var Tmpl", template: "About {active_note} in {vault_name} on {date} with {selected_notes}", isSystem: false }
      ]
    });
    const candidatesSpy = vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 50, selected: true, characterCount: 100 },
      { path: "Project.md", title: "Project", reason: "Recommended", reasonDetail: "Mentions focus", score: 8, excerpt: "Project details", tokenEstimate: 40, selected: true, characterCount: 80 }
    ]);
    const bundleSpy = vi.spyOn(vaultApi, "getContextBundle").mockResolvedValue({
      title: "Context Bundle: Home",
      focusPath: "Home.md",
      notePaths: ["Home.md", "Project.md"],
      markdown: "Bundle Content",
      estimatedTokens: 90
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    
    // Generate Bundle
    fireEvent.click(screen.getByRole("button", { name: "Generate bundle" }));

    await waitFor(() => expect(screen.getByText("Prompt Workspace")).toBeTruthy());

    // Expand templates dropdown
    fireEvent.click(screen.getByText("Templates ▾"));
    await waitFor(() => expect(screen.getByText("Var Tmpl")).toBeTruthy());
    
    // Select the template with placeholders
    fireEvent.click(screen.getByText("Var Tmpl"));

    const promptTextarea = screen.getByPlaceholderText("Ask a question or specify the task for the LLM...") as HTMLTextAreaElement;
    
    const currentDate = new Date().toLocaleDateString();
    expect(promptTextarea.value).toContain("About Home in Demo Vault on");
    expect(promptTextarea.value).toContain("with [[Home]], [[Project]]");

    getVaultConfigSpy.mockRestore();
    candidatesSpy.mockRestore();
    bundleSpy.mockRestore();
  });

  it("renders quality badges based on note size, score, and stale modification date", async () => {
    const staleDate = "2026-04-10T12:00:00.000Z";
    const freshDate = "2026-06-01T12:00:00.000Z";

    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [
        { path: "Home.md", title: "Home", tags: [], frontmatter: {}, modifiedAt: freshDate, contentHash: "123" },
        { path: "LargeNote.md", title: "LargeNote", tags: [], frontmatter: {}, modifiedAt: freshDate, contentHash: "456" },
        { path: "StaleNote.md", title: "StaleNote", tags: [], frontmatter: {}, modifiedAt: staleDate, contentHash: "789" },
        { path: "RedundantNote.md", title: "RedundantNote", tags: [], frontmatter: {}, modifiedAt: freshDate, contentHash: "abc" }
      ],
      tree: []
    });

    const candidatesSpy = vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 50, selected: true, characterCount: 100 },
      { path: "LargeNote.md", title: "LargeNote", reason: "Recommended", reasonDetail: "Large note", score: 8, excerpt: "Large excerpt", tokenEstimate: 3000, selected: true, characterCount: 12000 },
      { path: "StaleNote.md", title: "StaleNote", reason: "Outgoing", reasonDetail: "Stale outgoing", score: 7, excerpt: "Stale excerpt", tokenEstimate: 40, selected: true, characterCount: 150 },
      { path: "RedundantNote.md", title: "RedundantNote", reason: "Recommended", reasonDetail: "Redundant note", score: 3, excerpt: "Redundant excerpt", tokenEstimate: 30, selected: true, characterCount: 120 }
    ]);

    const bundleSpy = vi.spyOn(vaultApi, "getContextBundle").mockResolvedValue({
      title: "Context Bundle: Home",
      focusPath: "Home.md",
      notePaths: ["Home.md", "LargeNote.md", "StaleNote.md", "RedundantNote.md"],
      markdown: "Bundle Content",
      estimatedTokens: 3120
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    
    fireEvent.click(screen.getByRole("button", { name: "Generate bundle" }));
    await waitFor(() => expect(screen.getByText("🔍 Context Bundle Audit & Diff")).toBeTruthy());

    // Expand audit breakdown
    fireEvent.click(screen.getByText("🔍 Context Bundle Audit & Diff"));

    await waitFor(() => {
      const rows = Array.from(document.querySelectorAll(".auditNoteRow"));
      const homeRow = rows.find(r => r.querySelector(".auditNoteTitle")?.getAttribute("title") === "Home.md");
      const largeRow = rows.find(r => r.querySelector(".auditNoteTitle")?.getAttribute("title") === "LargeNote.md");
      const staleRow = rows.find(r => r.querySelector(".auditNoteTitle")?.getAttribute("title") === "StaleNote.md");
      const redundantRow = rows.find(r => r.querySelector(".auditNoteTitle")?.getAttribute("title") === "RedundantNote.md");

      expect(homeRow?.querySelector(".qualityBadge.useful")).toBeTruthy();
      expect(largeRow?.querySelector(".qualityBadge.large")).toBeTruthy();
      expect(staleRow?.querySelector(".qualityBadge.stale")).toBeTruthy();
      expect(staleRow?.querySelector(".qualityBadge.useful")).toBeTruthy();
      expect(redundantRow?.querySelector(".qualityBadge.redundant")).toBeTruthy();
    });

    openVaultSpy.mockRestore();
    candidatesSpy.mockRestore();
    bundleSpy.mockRestore();
  });

  it("filters history runs list and expands cards for audits detail and copy actions", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: writeTextMock
      },
      writable: true,
      configurable: true
    });

    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      contextLimit: 8000,
      bundleMode: "standard",
      bundlePreset: "ask",
      promptRuns: [
        {
          id: "run-1",
          question: "Summarize history run 1",
          selectedNotes: ["Home.md"],
          preset: "ask",
          purpose: "Summarize this vault for a follow-up LLM prompt.",
          mode: "standard",
          tokenCount: 150,
          createdAt: "2026-06-05T14:00:00.000Z",
          activePath: "Home.md",
          promptHash: "abc12345",
          preview: "Preview of run 1"
        },
        {
          id: "run-2",
          question: "Draft test run 2",
          selectedNotes: ["Project.md"],
          preset: "write",
          purpose: "Write draft",
          mode: "full",
          tokenCount: 450,
          createdAt: "2026-06-05T14:10:00.000Z",
          activePath: "Project.md",
          promptHash: "def67890",
          preview: "Preview of run 2"
        }
      ]
    });

    const bundleSpy = vi.spyOn(vaultApi, "getContextBundle").mockResolvedValue({
      title: "Context Bundle: Project",
      focusPath: "Project.md",
      notePaths: ["Project.md"],
      markdown: "Project Bundle Content",
      estimatedTokens: 300
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Prompt History")).toBeTruthy());
    expect(screen.getByText("Summarize history run 1")).toBeTruthy();
    expect(screen.getByText("Draft test run 2")).toBeTruthy();

    // 1. Filter by preset dropdown
    const presetSelect = document.querySelector(".historyPresetSelect") as HTMLSelectElement;
    expect(presetSelect).toBeTruthy();
    fireEvent.change(presetSelect, { target: { value: "write" } });
    
    await waitFor(() => {
      expect(screen.queryByText("Summarize history run 1")).toBeNull();
      expect(screen.getByText("Draft test run 2")).toBeTruthy();
    });

    // Reset preset filter
    fireEvent.change(presetSelect, { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("Summarize history run 1")).toBeTruthy());

    // 2. Filter by search input
    const searchInput = document.querySelector(".historySearchField") as HTMLInputElement;
    expect(searchInput).toBeTruthy();
    fireEvent.change(searchInput, { target: { value: "run 1" } });

    await waitFor(() => {
      expect(screen.getByText("Summarize history run 1")).toBeTruthy();
      expect(screen.queryByText("Draft test run 2")).toBeNull();
    });

    // Clear search
    fireEvent.change(searchInput, { target: { value: "" } });

    // 3. Expand run card
    const card2 = document.querySelector(".promptRunCard:nth-child(2)") as HTMLElement;
    expect(card2).toBeTruthy();
    fireEvent.click(card2);

    await waitFor(() => {
      expect(screen.getByText("def67890")).toBeTruthy();
      const textarea = document.querySelector(".expandedPreviewTextarea") as HTMLTextAreaElement;
      expect(textarea.value).toBe("Preview of run 2");
    });

    // 4. Click Copy Full Prompt
    const copyFullBtn = Array.from(card2.querySelectorAll("button")).find(btn => btn.textContent === "Copy Full Prompt")!;
    fireEvent.click(copyFullBtn);

    await waitFor(() => {
      expect(bundleSpy).toHaveBeenCalledWith("Project.md", expect.objectContaining({
        preset: "write",
        mode: "full"
      }));
      expect(writeTextMock).toHaveBeenCalledWith("Draft test run 2\n\n---\n\nProject Bundle Content");
    });

    getVaultConfigSpy.mockRestore();
    bundleSpy.mockRestore();
  });

  it("archives prompts and compares them in the history diff view", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: writeTextMock
      },
      writable: true,
      configurable: true
    });

    const archiveSpy = vi.spyOn(vaultApi, "archivePromptRun").mockResolvedValue("mocked-sha256-hash");
    const getArchiveSpy = vi.spyOn(vaultApi, "getArchivedPrompt").mockResolvedValue("Exact archived content here");

    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      contextLimit: 8000,
      bundleMode: "standard",
      bundlePreset: "ask",
      promptRuns: [
        {
          id: "run-archive-test",
          question: "Stored run instruction",
          selectedNotes: ["Home.md"],
          preset: "ask",
          purpose: "Summarize this vault.",
          mode: "standard",
          tokenCount: 150,
          createdAt: "2026-06-05T14:00:00.000Z",
          activePath: "Home.md",
          promptHash: "abc12345",
          preview: "Preview of archived run"
        }
      ]
    });

    const candidatesSpy = vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 50, selected: true, characterCount: 100 }
    ]);

    const bundleSpy = vi.spyOn(vaultApi, "getContextBundle").mockResolvedValue({
      title: "Context Bundle: Home",
      focusPath: "Home.md",
      notePaths: ["Home.md", "Project.md"],
      markdown: "Home and Project Bundle Content",
      estimatedTokens: 90
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Prompt History")).toBeTruthy());

    // 1. Generate bundle to have a current context bundle
    fireEvent.click(screen.getByRole("button", { name: "Generate bundle" }));
    await waitFor(() => expect(screen.getByText("Prompt Workspace")).toBeTruthy());

    // Set current question to differ
    const promptTextarea = screen.getByPlaceholderText("Ask a question or specify the task for the LLM...") as HTMLTextAreaElement;
    fireEvent.change(promptTextarea, { target: { value: "Current session instruction" } });

    // 2. Expand card
    const card = document.querySelector(".promptRunCard") as HTMLElement;
    expect(card).toBeTruthy();
    fireEvent.click(card);

    // 3. Diff should show up
    await waitFor(() => {
      expect(screen.getByText("🔍 Session Comparison")).toBeTruthy();
      expect(screen.getByText("🟡 Modified")).toBeTruthy();
      expect(screen.getByText("+Project.md")).toBeTruthy();
      expect(screen.getByText("- Stored run instruction")).toBeTruthy();
      expect(screen.getByText("+ Current session instruction")).toBeTruthy();
    });

    // 4. Copy Full Prompt should use archived content
    const copyFullBtn = Array.from(card.querySelectorAll("button")).find(btn => btn.textContent === "Copy Full Prompt")!;
    fireEvent.click(copyFullBtn);

    await waitFor(() => {
      expect(getArchiveSpy).toHaveBeenCalledWith("run-archive-test");
      expect(writeTextMock).toHaveBeenCalledWith("Exact archived content here");
    });

    archiveSpy.mockRestore();
    getArchiveSpy.mockRestore();
    getVaultConfigSpy.mockRestore();
    candidatesSpy.mockRestore();
    bundleSpy.mockRestore();
  });

  it("supports delete, prune, and unified line-by-line diffing for archived prompt runs", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const statusSpy = vi.spyOn(vaultApi, "getArchiveStatus").mockResolvedValue({ fileCount: 5, totalBytes: 20480 });
    const deletePromptSpy = vi.spyOn(vaultApi, "deleteArchivedPrompt").mockResolvedValue();
    const pruneSpy = vi.spyOn(vaultApi, "pruneArchivedPrompts").mockResolvedValue();
    const getArchiveSpy = vi.spyOn(vaultApi, "getArchivedPrompt").mockResolvedValue("Exact archived content here\nLine 2");
    const saveConfigSpy = vi.spyOn(vaultApi, "saveVaultConfig").mockResolvedValue();

    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      contextLimit: 8000,
      bundleMode: "standard",
      bundlePreset: "ask",
      promptRuns: [
        {
          id: "run-delete-diff-test",
          question: "Stored run instruction",
          selectedNotes: ["Home.md"],
          preset: "ask",
          purpose: "Summarize.",
          mode: "standard",
          tokenCount: 100,
          createdAt: "2026-06-05T14:00:00.000Z",
          activePath: "Home.md",
          promptHash: "hash-diff",
          preview: "Preview"
        }
      ]
    });

    const candidatesSpy = vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 50, selected: true, characterCount: 100 }
    ]);

    const bundleSpy = vi.spyOn(vaultApi, "getContextBundle").mockResolvedValue({
      title: "Context Bundle: Home",
      focusPath: "Home.md",
      notePaths: ["Home.md"],
      markdown: "Different workspace prompt content\nLine 2",
      estimatedTokens: 90
    });

    render(<App />);

    // Wait for App to load
    await waitFor(() => expect(screen.getByText("Prompt History")).toBeTruthy());

    // 1. Verify archive status bar rendering
    await waitFor(() => {
      expect(screen.getByText(/Archive:/)).toBeTruthy();
      expect(screen.getByText("5")).toBeTruthy();
      expect(screen.getByText(/20.0 KB/)).toBeTruthy();
    });

    // 2. Generate workspace bundle so that there is a current combined prompt to compare with
    fireEvent.click(screen.getByRole("button", { name: "Generate bundle" }));
    await waitFor(() => expect(screen.getByText("Prompt Workspace")).toBeTruthy());

    // Set current question to match
    const promptTextarea = screen.getByPlaceholderText("Ask a question or specify the task for the LLM...") as HTMLTextAreaElement;
    fireEvent.change(promptTextarea, { target: { value: "Stored run instruction" } });

    // 3. Expand the history card
    const card = document.querySelector(".promptRunCard") as HTMLElement;
    expect(card).toBeTruthy();
    fireEvent.click(card);

    // 4. Click Unified Prompt Diff button
    await waitFor(() => expect(screen.getByText("Compare Full Text (Exact)")).toBeTruthy());
    const compareBtn = screen.getByText("Compare Full Text (Exact)");
    fireEvent.click(compareBtn);

    // 5. Verify line-by-line diff rendering
    await waitFor(() => {
      expect(screen.getByText("Unified Prompt Diff")).toBeTruthy();
      // "Exact archived content here" was deleted, "Different workspace prompt content" was added
      const removedTexts = Array.from(document.querySelectorAll(".diffLine.removed")).map((el) => el.textContent);
      const addedTexts = Array.from(document.querySelectorAll(".diffLine.added")).map((el) => el.textContent);
      expect(removedTexts.some((t) => t?.includes("Exact archived content here"))).toBe(true);
      expect(addedTexts.some((t) => t?.includes("Different workspace prompt content"))).toBe(true);
    });

    // 6. Click Prune Orphaned button
    const pruneBtn = screen.getByText("Prune Orphaned");
    fireEvent.click(pruneBtn);
    await waitFor(() => {
      expect(pruneSpy).toHaveBeenCalledWith(["run-delete-diff-test"]);
    });

    // 7. Click Delete button
    const deleteBtn = card.querySelector(".smallButton.dangerButton") as HTMLButtonElement;
    expect(deleteBtn).toBeTruthy();
    fireEvent.click(deleteBtn);
    await waitFor(() => {
      expect(deletePromptSpy).toHaveBeenCalledWith("run-delete-diff-test");
      expect(saveConfigSpy).toHaveBeenCalled();
    });

    statusSpy.mockRestore();
    deletePromptSpy.mockRestore();
    pruneSpy.mockRestore();
    getArchiveSpy.mockRestore();
    saveConfigSpy.mockRestore();
    getVaultConfigSpy.mockRestore();
    candidatesSpy.mockRestore();
    bundleSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it("asks for confirmation before deleting or pruning prompt archives", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const statusSpy = vi.spyOn(vaultApi, "getArchiveStatus").mockResolvedValue({ fileCount: 2, totalBytes: 1024 });
    const deletePromptSpy = vi.spyOn(vaultApi, "deleteArchivedPrompt").mockResolvedValue();
    const pruneSpy = vi.spyOn(vaultApi, "pruneArchivedPrompts").mockResolvedValue();
    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      promptRuns: [
        {
          id: "run-confirm-test",
          question: "Confirm test",
          selectedNotes: ["Home.md"],
          preset: "ask",
          purpose: "Ask",
          mode: "standard",
          tokenCount: 100,
          createdAt: "2026-06-05T14:00:00.000Z",
          activePath: "Home.md",
          promptHash: "hash",
          preview: "Preview"
        }
      ]
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Prompt History")).toBeTruthy());

    fireEvent.click(screen.getByText("Prune Orphaned"));
    expect(confirmSpy).toHaveBeenCalledWith("Prune archived prompt files that no longer have history entries?");
    expect(pruneSpy).not.toHaveBeenCalled();

    const deleteBtn = document.querySelector(".smallButton.dangerButton") as HTMLButtonElement;
    expect(deleteBtn).toBeTruthy();
    fireEvent.click(deleteBtn);
    expect(confirmSpy).toHaveBeenCalledWith("Delete this prompt history entry and its archived prompt?");
    expect(deletePromptSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
    statusSpy.mockRestore();
    deletePromptSpy.mockRestore();
    pruneSpy.mockRestore();
    getVaultConfigSpy.mockRestore();
  });

  it("allows navigating to Distill workspace, loading mock proposal, inline editing, and applying checked edits", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const createNoteSpy = vi.spyOn(vaultApi, "createNote").mockResolvedValue({
      vault: { rootPath: "Demo Vault", notes: [], tree: [] },
      selectedPath: "Research/Compounding Memory.md"
    });
    const saveNoteSpy = vi.spyOn(vaultApi, "saveNote").mockResolvedValue({
      saved: true,
      revision: "rev-new",
      conflict: false,
      snapshotId: null,
      gitCommit: null
    });
    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Home.md",
      content: "Welcome to the local wiki workspace!",
      revision: "rev-home"
    });
    const deleteEntrySpy = vi.spyOn(vaultApi, "deleteEntry").mockResolvedValue({
      vault: { rootPath: "Demo Vault", notes: [], tree: [] },
      selectedPath: null
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    // 1. Go to Distill Workspace
    const distillTabBtn = screen.getByRole("button", { name: "Distill" });
    fireEvent.click(distillTabBtn);
    expect(screen.getByText("LLM Distill Workspace")).toBeTruthy();

    // 2. Load Mock Proposal
    const loadMockBtn = screen.getByText("Load Mock Proposal");
    fireEvent.click(loadMockBtn);
    
    // Distill textarea should populate
    const textarea = document.querySelector(".distillTextarea") as HTMLTextAreaElement;
    expect(textarea.value).toContain("<propose_edit");

    // 3. Click "Propose Wiki Edits"
    const proposeBtn = screen.getByText("Propose Wiki Edits");
    fireEvent.click(proposeBtn);

    // Cards should render
    await waitFor(() => expect(screen.getByText("Research/Compounding Memory.md")).toBeTruthy());
    expect(screen.getAllByText("Home.md").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("TempDraft.md").length).toBeGreaterThanOrEqual(1);

    // Verify badges
    expect(screen.getAllByText("create").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("update").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("delete").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("merge").length).toBeGreaterThanOrEqual(1);

    // Inline edit create proposal
    const textareas = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    const createTextarea = textareas.find((ta) => ta.classList.contains("proposalTextarea") && ta.value.includes("Persistent synthesis"));
    expect(createTextarea).toBeTruthy();
    fireEvent.change(createTextarea!, { target: { value: "# Compounding Memory - Updated" } });

    // Apply checked edits
    const applyBtn = screen.getByText("Apply Checked Edits");
    fireEvent.click(applyBtn);

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith("Apply 4 proposed wiki edit(s), including 2 destructive edit(s)?");
      expect(createNoteSpy).toHaveBeenCalledWith("Research", "Compounding Memory");
      expect(saveNoteSpy).toHaveBeenCalledWith("Research/Compounding Memory.md", "# Compounding Memory - Updated", "");
      expect(readNoteSpy).toHaveBeenCalledWith("Home.md");
      expect(saveNoteSpy).toHaveBeenCalledWith(
        "Home.md",
        "Welcome to the local wiki workspace! Explore the new [[Research/Compounding Memory]] note.",
        "rev-home"
      );
      expect(deleteEntrySpy).toHaveBeenCalledWith("TempDraft.md");
      expect(deleteEntrySpy).toHaveBeenCalledWith("StaleNotes.md");
    });
    const mergeDeleteOrder = deleteEntrySpy.mock.invocationCallOrder.find((_, index) => deleteEntrySpy.mock.calls[index][0] === "StaleNotes.md");
    const mergeSaveOrder = saveNoteSpy.mock.invocationCallOrder.find((_, index) => saveNoteSpy.mock.calls[index][0] === "Home.md" && saveNoteSpy.mock.calls[index][1].includes("Also merging relevant guidelines"));
    expect(mergeSaveOrder).not.toBeUndefined();
    expect(mergeDeleteOrder).not.toBeUndefined();
    expect(mergeSaveOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(mergeDeleteOrder ?? Number.NEGATIVE_INFINITY);

    confirmSpy.mockRestore();
    createNoteSpy.mockRestore();
    saveNoteSpy.mockRestore();
    readNoteSpy.mockRestore();
    deleteEntrySpy.mockRestore();
  });

  it("does not apply checked distill edits when confirmation is cancelled", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const createNoteSpy = vi.spyOn(vaultApi, "createNote");
    const saveNoteSpy = vi.spyOn(vaultApi, "saveNote");
    const deleteEntrySpy = vi.spyOn(vaultApi, "deleteEntry");

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Distill" }));
    fireEvent.click(screen.getByText("Load Mock Proposal"));
    fireEvent.click(screen.getByText("Propose Wiki Edits"));

    await waitFor(() => expect(screen.getByText("Research/Compounding Memory.md")).toBeTruthy());
    fireEvent.click(screen.getByText("Apply Checked Edits"));

    expect(confirmSpy).toHaveBeenCalledWith("Apply 4 proposed wiki edit(s), including 2 destructive edit(s)?");
    expect(createNoteSpy).not.toHaveBeenCalled();
    expect(saveNoteSpy).not.toHaveBeenCalled();
    expect(deleteEntrySpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
    createNoteSpy.mockRestore();
    saveNoteSpy.mockRestore();
    deleteEntrySpy.mockRestore();
  });

  it("scans for unresolved wiki links, drafts a stub with LLM, and creates the note", async () => {
    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [
        { path: "Home.md", title: "Home", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "123" }
      ],
      tree: []
    });

    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Home.md",
      content: "Welcome, see the [[Missing Target]] dead link.",
      revision: "rev-123"
    });

    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      llmConfig: { provider: "openai", apiKey: "test-key", model: "gpt-4o" }
    });

    const sendChatMessageSpy = vi.spyOn(llmApi, "sendChatMessage").mockResolvedValue("This is the drafted AI stub note content.");

    const createNoteSpy = vi.spyOn(vaultApi, "createNote").mockResolvedValue({
      vault: { rootPath: "Demo Vault", notes: [], tree: [] },
      selectedPath: "Missing Target.md"
    });

    const saveNoteSpy = vi.spyOn(vaultApi, "saveNote").mockResolvedValue({
      saved: true,
      revision: "rev-456",
      conflict: false,
      snapshotId: null,
      gitCommit: null
    });

    const getUnresolvedLinksSpy = vi.spyOn(vaultApi, "getUnresolvedLinks").mockResolvedValue([
      {
        target: "Missing Target",
        sources: [
          { path: "Home.md", title: "Home", excerpt: "Welcome, see the [[Missing Target]] dead link." }
        ]
      }
    ]);

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    // Switch to Distill Workspace
    const distillTabBtn = screen.getByRole("button", { name: "Distill" });
    fireEvent.click(distillTabBtn);
    expect(screen.getByText("LLM Distill Workspace")).toBeTruthy();

    // Click on Wiki Auditor tab
    const auditorTabBtn = screen.getByRole("button", { name: "Wiki Auditor" });
    fireEvent.click(auditorTabBtn);

    // Switch to Dead Links Scanner sub-tab
    const deadLinksSubTabBtn = screen.getByRole("button", { name: "Dead Links Scanner" });
    fireEvent.click(deadLinksSubTabBtn);

    // Verify it performs the scan and shows the unresolved link target
    await waitFor(() => expect(screen.getByText("[[Missing Target]]")).toBeTruthy());
    expect(screen.getByText("Referenced in:")).toBeTruthy();
    expect(screen.getByText((_content, element) => element?.textContent === "Home (Home.md)")).toBeTruthy();

    // Click Draft Stub button
    const draftStubBtn = screen.getByRole("button", { name: "Draft Stub" });
    fireEvent.click(draftStubBtn);
    // Verify draft stub loading, then draft content preview shows up
    await waitFor(() => expect(screen.getByText("✓ Approved")).toBeTruthy());
    const textarea = document.querySelector(".stubPreviewTextarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe("This is the drafted AI stub note content.");

    // Click Create Selected button (since single stub drafting uses bulk creation flow)
    const createSelectedBtn = screen.getByRole("button", { name: "Create Approved (1)" });
    fireEvent.click(createSelectedBtn);

    // Verify vaultApi.createNote and saveNote were called
    await waitFor(() => {
      expect(createNoteSpy).toHaveBeenCalledWith(null, "Missing Target");
      expect(saveNoteSpy).toHaveBeenCalledWith("Missing Target.md", "This is the drafted AI stub note content.", "");
    });

    // Cleanup spies
    openVaultSpy.mockRestore();
    readNoteSpy.mockRestore();
    getVaultConfigSpy.mockRestore();
    sendChatMessageSpy.mockRestore();
    createNoteSpy.mockRestore();
    saveNoteSpy.mockRestore();
    getUnresolvedLinksSpy.mockRestore();
  });

  it("scans and resolves unresolved links in bulk", async () => {
    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [
        { path: "Home.md", title: "Home", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "123" }
      ],
      tree: []
    });

    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Home.md",
      content: "Welcome, see the [[Missing One]] and [[Missing Two]] dead links.",
      revision: "rev-123"
    });


    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      llmConfig: { provider: "openai", apiKey: "test-key", model: "gpt-4o" }
    });

    const sendChatMessageSpy = vi.spyOn(llmApi, "sendChatMessage").mockResolvedValue("This is the drafted AI stub note content.");

    const createNoteSpy = vi.spyOn(vaultApi, "createNote").mockImplementation(async (dir, name) => {
      return {
        vault: { rootPath: "Demo Vault", notes: [], tree: [] },
        selectedPath: `${name}.md`
      };
    });

    const saveNoteSpy = vi.spyOn(vaultApi, "saveNote").mockResolvedValue({
      saved: true,
      revision: "rev-456",
      conflict: false,
      snapshotId: null,
      gitCommit: null
    });

    const getUnresolvedLinksSpy = vi.spyOn(vaultApi, "getUnresolvedLinks").mockResolvedValue([
      {
        target: "Missing One",
        sources: [
          { path: "Home.md", title: "Home", excerpt: "Welcome, see the [[Missing One]] and [[Missing Two]] dead links." }
        ]
      },
      {
        target: "Missing Two",
        sources: [
          { path: "Home.md", title: "Home", excerpt: "Welcome, see the [[Missing One]] and [[Missing Two]] dead links." }
        ]
      }
    ]);

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    // Switch to Distill Workspace
    const distillTabBtn = screen.getByRole("button", { name: "Distill" });
    fireEvent.click(distillTabBtn);
    expect(screen.getByText("LLM Distill Workspace")).toBeTruthy();

    // Click on Wiki Auditor tab
    const auditorTabBtn = screen.getByRole("button", { name: "Wiki Auditor" });
    fireEvent.click(auditorTabBtn);

    // Switch to Dead Links Scanner sub-tab
    const deadLinksSubTabBtn = screen.getByRole("button", { name: "Dead Links Scanner" });
    fireEvent.click(deadLinksSubTabBtn);

    // Verify it performs the scan and shows the unresolved link targets
    await waitFor(() => expect(screen.getByText("[[Missing One]]")).toBeTruthy());
    expect(screen.getByText("[[Missing Two]]")).toBeTruthy();

    // Verify "Select All" checkbox behaves correctly
    const selectAllCheckbox = document.querySelector(".bulkActionsBar input[type='checkbox']") as HTMLInputElement;
    expect(selectAllCheckbox).toBeTruthy();
    expect(selectAllCheckbox.checked).toBe(false);

    // Click "Select All"
    fireEvent.click(selectAllCheckbox);
    expect(selectAllCheckbox.checked).toBe(true);

    // Verify both checkboxes for targets are checked
    const checkboxes = Array.from(document.querySelectorAll(".unresolvedLinkCard input[type='checkbox']")) as HTMLInputElement[];
    expect(checkboxes.length).toBe(2);
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[1].checked).toBe(true);

    // Click "Draft Selected (2)" button
    const draftSelectedBtn = screen.getByRole("button", { name: "Draft Selected (2)" });
    fireEvent.click(draftSelectedBtn);

    // Verify sendChatMessage is called
    await waitFor(() => expect(sendChatMessageSpy).toHaveBeenCalled());
    // Verify both drafts are loaded and textareas appear with the draft content
    await waitFor(() => expect(screen.getAllByText("✓ Approved").length).toBe(2));

    const textareas = Array.from(document.querySelectorAll(".stubPreviewTextarea")) as HTMLTextAreaElement[];
    expect(textareas.length).toBe(2);
    expect(textareas[0].value).toBe("This is the drafted AI stub note content.");
    expect(textareas[1].value).toBe("This is the drafted AI stub note content.");

    // Click "Create Selected" button to write them to the vault
    const createSelectedBtn = screen.getByRole("button", { name: "Create Approved (2)" });
    fireEvent.click(createSelectedBtn);

    // Verify createNote and saveNote were called for both
    await waitFor(() => {
      expect(createNoteSpy).toHaveBeenCalledWith(null, "Missing One");
      expect(createNoteSpy).toHaveBeenCalledWith(null, "Missing Two");
      expect(saveNoteSpy).toHaveBeenCalledWith("Missing One.md", "This is the drafted AI stub note content.", "");
      expect(saveNoteSpy).toHaveBeenCalledWith("Missing Two.md", "This is the drafted AI stub note content.", "");
    });

    // Cleanup spies
    openVaultSpy.mockRestore();
    readNoteSpy.mockRestore();
    getVaultConfigSpy.mockRestore();
    sendChatMessageSpy.mockRestore();
    createNoteSpy.mockRestore();
    saveNoteSpy.mockRestore();
    getUnresolvedLinksSpy.mockRestore();
  });

  it("keeps failed bulk stub creations available for retry", async () => {
    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [
        { path: "Home.md", title: "Home", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "123" }
      ],
      tree: []
    });

    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Home.md",
      content: "Welcome, see the [[Missing One]] and [[Missing Two]] dead links.",
      revision: "rev-123"
    });

    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      llmConfig: { provider: "openai", apiKey: "test-key", model: "gpt-4o" }
    });

    const sendChatMessageSpy = vi.spyOn(llmApi, "sendChatMessage").mockResolvedValue("This is the drafted AI stub note content.");

    const createNoteSpy = vi.spyOn(vaultApi, "createNote").mockImplementation(async (_dir, name) => ({
      vault: { rootPath: "Demo Vault", notes: [], tree: [] },
      selectedPath: `${name}.md`
    }));

    const saveNoteSpy = vi.spyOn(vaultApi, "saveNote")
      .mockResolvedValueOnce({
        saved: true,
        revision: "rev-456",
        conflict: false,
        snapshotId: null,
        gitCommit: null
      })
      .mockResolvedValueOnce({
        saved: false,
        revision: "rev-789",
        conflict: false,
        snapshotId: null,
        gitCommit: null
      });

    const getUnresolvedLinksSpy = vi.spyOn(vaultApi, "getUnresolvedLinks").mockResolvedValue([
      {
        target: "Missing One",
        sources: [
          { path: "Home.md", title: "Home", excerpt: "Welcome, see the [[Missing One]] and [[Missing Two]] dead links." }
        ]
      },
      {
        target: "Missing Two",
        sources: [
          { path: "Home.md", title: "Home", excerpt: "Welcome, see the [[Missing One]] and [[Missing Two]] dead links." }
        ]
      }
    ]);

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Distill" }));
    fireEvent.click(screen.getByRole("button", { name: "Wiki Auditor" }));
    fireEvent.click(screen.getByRole("button", { name: "Dead Links Scanner" }));

    await waitFor(() => expect(screen.getByText("[[Missing One]]")).toBeTruthy());
    const selectAllCheckbox = document.querySelector(".bulkActionsBar input[type='checkbox']") as HTMLInputElement;
    fireEvent.click(selectAllCheckbox);
    fireEvent.click(screen.getByRole("button", { name: "Draft Selected (2)" }));

    await waitFor(() => expect(sendChatMessageSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelectorAll(".reviewBadge.approved").length).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Create Approved (2)" }));

    await waitFor(() => {
      expect(saveNoteSpy).toHaveBeenCalledWith("Missing One.md", "This is the drafted AI stub note content.", "");
      expect(saveNoteSpy).toHaveBeenCalledWith("Missing Two.md", "This is the drafted AI stub note content.", "");
    });

    fireEvent.click(screen.getByRole("button", { name: "Distill" }));
    fireEvent.click(screen.getByRole("button", { name: "Wiki Auditor" }));
    fireEvent.click(screen.getByRole("button", { name: "Dead Links Scanner" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Create Approved (1)" })).toBeTruthy());

    const textareas = Array.from(document.querySelectorAll(".stubPreviewTextarea")) as HTMLTextAreaElement[];
    expect(textareas.length).toBe(1);
    expect(textareas[0].value).toBe("This is the drafted AI stub note content.");

    openVaultSpy.mockRestore();
    readNoteSpy.mockRestore();
    getVaultConfigSpy.mockRestore();
    sendChatMessageSpy.mockRestore();
    createNoteSpy.mockRestore();
    saveNoteSpy.mockRestore();
    getUnresolvedLinksSpy.mockRestore();
  });

  it("allows individual approval and rejection of drafts before creation", async () => {
    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [
        { path: "Home.md", title: "Home", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "123" }
      ],
      tree: []
    });

    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Home.md",
      content: "Welcome, see the [[Missing One]] and [[Missing Two]] dead links.",
      revision: "rev-123"
    });

    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      llmConfig: { provider: "openai", apiKey: "test-key", model: "gpt-4o" }
    });

    const sendChatMessageSpy = vi.spyOn(llmApi, "sendChatMessage").mockResolvedValue("This is the drafted AI stub note content.");

    const createNoteSpy = vi.spyOn(vaultApi, "createNote").mockImplementation(async (dir, name) => {
      return {
        vault: { rootPath: "Demo Vault", notes: [], tree: [] },
        selectedPath: `${name}.md`
      };
    });

    const saveNoteSpy = vi.spyOn(vaultApi, "saveNote").mockResolvedValue({
      saved: true,
      revision: "rev-456",
      conflict: false,
      snapshotId: null,
      gitCommit: null
    });

    const getUnresolvedLinksSpy = vi.spyOn(vaultApi, "getUnresolvedLinks").mockResolvedValue([
      {
        target: "Missing One",
        sources: [
          { path: "Home.md", title: "Home", excerpt: "Welcome, see the [[Missing One]] and [[Missing Two]] dead links." }
        ]
      },
      {
        target: "Missing Two",
        sources: [
          { path: "Home.md", title: "Home", excerpt: "Welcome, see the [[Missing One]] and [[Missing Two]] dead links." }
        ]
      }
    ]);

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    // Switch to Distill Workspace
    const distillTabBtn = screen.getByRole("button", { name: "Distill" });
    fireEvent.click(distillTabBtn);

    // Click on Wiki Auditor tab
    const auditorTabBtn = screen.getByRole("button", { name: "Wiki Auditor" });
    fireEvent.click(auditorTabBtn);

    // Switch to Dead Links Scanner sub-tab
    const deadLinksSubTabBtn = screen.getByRole("button", { name: "Dead Links Scanner" });
    fireEvent.click(deadLinksSubTabBtn);

    // Verify it performs the scan and shows the unresolved link targets
    await waitFor(() => expect(screen.getByText("[[Missing One]]")).toBeTruthy());

    // Click "Select All"
    const selectAllCheckbox = document.querySelector(".bulkActionsBar input[type='checkbox']") as HTMLInputElement;
    fireEvent.click(selectAllCheckbox);

    // Click "Draft Selected (2)" button
    const draftSelectedBtn = screen.getByRole("button", { name: "Draft Selected (2)" });
    fireEvent.click(draftSelectedBtn);

    // Verify both drafts are loaded and marked Approved by default
    await waitFor(() => expect(screen.getAllByText("✓ Approved").length).toBe(2));

    // Find the cards. Card 1: Missing One, Card 2: Missing Two
    // Reject Card 2 ("Missing Two")
    const rejectButtons = screen.getAllByRole("button", { name: "Reject" });
    expect(rejectButtons.length).toBe(2);
    fireEvent.click(rejectButtons[1]); // Click reject on "Missing Two"

    // Verify Card 2 changes to "✗ Rejected"
    await waitFor(() => expect(screen.getByText("✗ Rejected")).toBeTruthy());
    expect(screen.getByText("✓ Approved")).toBeTruthy(); // Missing One is still approved

    // Verify textareas - Missing Two textarea should be disabled
    const textareas = Array.from(document.querySelectorAll(".stubPreviewTextarea")) as HTMLTextAreaElement[];
    expect(textareas.length).toBe(2);
    expect(textareas[0].disabled).toBe(false);
    expect(textareas[1].disabled).toBe(true);

    // Verify Create button says "Create Approved (1)"
    const createBtn = screen.getByRole("button", { name: "Create Approved (1)" });
    fireEvent.click(createBtn);

    // Verify only "Missing One" was created, not "Missing Two"
    await waitFor(() => {
      expect(createNoteSpy).toHaveBeenCalledWith(null, "Missing One");
      expect(createNoteSpy).not.toHaveBeenCalledWith(null, "Missing Two");
      expect(saveNoteSpy).toHaveBeenCalledWith("Missing One.md", "This is the drafted AI stub note content.", "");
      expect(saveNoteSpy).not.toHaveBeenCalledWith("Missing Two.md", "This is the drafted AI stub note content.", "");
    });

    // Cleanup spies
    openVaultSpy.mockRestore();
    readNoteSpy.mockRestore();
    getVaultConfigSpy.mockRestore();
    sendChatMessageSpy.mockRestore();
    createNoteSpy.mockRestore();
    saveNoteSpy.mockRestore();
    getUnresolvedLinksSpy.mockRestore();
  });

  it("recommends bidirectional backlink suggestions and applies them inline", async () => {
    const mockSuggestion = {
      id: "mention:Home.md:Projects/Obsidian Replacement.md",
      sourcePath: "Home.md",
      sourceTitle: "Home",
      targetPath: "Projects/Obsidian Replacement.md",
      targetTitle: "Obsidian Replacement",
      suggestionType: "unlinked_mention" as const,
      excerpt: "Explore Obsidian Replacement and Markdown Systems.",
      score: 1.0
    };

    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [
        { path: "Home.md", title: "Home", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "123" },
        { path: "Projects/Obsidian Replacement.md", title: "Obsidian Replacement", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "456" }
      ],
      tree: [
        { kind: "note", name: "Home.md", path: "Home.md", children: [] },
        {
          kind: "folder",
          name: "Projects",
          path: "Projects",
          children: [
            { kind: "note", name: "Obsidian Replacement.md", path: "Projects/Obsidian Replacement.md", children: [] }
          ]
        }
      ],
      obsidianSettings: null
    });

    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Projects/Obsidian Replacement.md",
      content: "Build a local-first Markdown app with backlinks, search, and graph editing.",
      revision: "rev-456"
    });

    const getSuggestionsSpy = vi.spyOn(vaultApi, "getBacklinkSuggestions").mockResolvedValue([mockSuggestion]);
    const applySuggestionSpy = vi.spyOn(vaultApi, "applyBacklinkSuggestion").mockResolvedValue();

    render(<App />);

    // Wait for the app to load
    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    // Switch note to "Projects/Obsidian Replacement.md"
    const obsidianNoteBtn = screen.getByText("Obsidian Replacement.md");
    fireEvent.click(obsidianNoteBtn);

    // Verify suggestions scan is loaded and shows suggestion
    await waitFor(() => expect(getSuggestionsSpy).toHaveBeenCalledWith("Projects/Obsidian Replacement.md"));
    fireEvent.click(screen.getByRole("button", { name: "Link Suggestions" }));
    await waitFor(() => expect(screen.getByText("In other Notes (1)")).toBeTruthy());
    
    const suggestionsSection = document.querySelector(".linkSuggestionsSidebar");
    expect(suggestionsSection).toBeTruthy();
    expect(suggestionsSection!.textContent).toContain("Home");
    expect(suggestionsSection!.textContent).toContain("Link Mention");
    expect(suggestionsSection!.textContent).toContain("Explore Obsidian Replacement and Markdown Systems.");

    // Click "Link Mention" button
    const applyBtn = screen.getByRole("button", { name: "Link Mention" });
    fireEvent.click(applyBtn);

    // Verify applyBacklinkSuggestion is called
    await waitFor(() => expect(applySuggestionSpy).toHaveBeenCalledWith(mockSuggestion));

    openVaultSpy.mockRestore();
    readNoteSpy.mockRestore();
    getSuggestionsSpy.mockRestore();
    applySuggestionSpy.mockRestore();
  });

  it("inserts a sidebar wiki link at the editor cursor", async () => {
    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [
        { path: "Home.md", title: "Home", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "123" },
        { path: "Projects/Obsidian Replacement.md", title: "Obsidian Replacement", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "456" }
      ],
      tree: [
        { kind: "note", name: "Home.md", path: "Home.md", children: [] },
        { kind: "note", name: "Obsidian Replacement.md", path: "Projects/Obsidian Replacement.md", children: [] }
      ],
      obsidianSettings: null
    });

    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Home.md",
      content: "Alpha  omega",
      revision: "rev-123"
    });
    const getContextSpy = vi.spyOn(vaultApi, "getNoteContext").mockResolvedValue({
      note: {
        path: "Home.md",
        title: "Home",
        tags: [],
        frontmatter: {},
        modifiedAt: "2026-06-01T12:00:00.000Z",
        contentHash: "123",
        content: "Alpha  omega",
        links: []
      },
      backlinks: [],
      outgoingLinks: []
    });

    vi.spyOn(vaultApi, "getBacklinkSuggestions").mockResolvedValue([
      {
        id: "semantic:Projects/Obsidian Replacement.md",
        sourcePath: "Projects/Obsidian Replacement.md",
        sourceTitle: "Obsidian Replacement",
        targetPath: "Home.md",
        targetTitle: "Home",
        suggestionType: "semantic",
        excerpt: "Related project note.",
        score: 0.84
      }
    ]);

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    const editor = screen.getByTestId("mock-editor") as HTMLTextAreaElement;
    editor.setSelectionRange(6, 6);

    fireEvent.click(screen.getByRole("button", { name: "Link Suggestions" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Insert" })[0]);

    await waitFor(() => expect(editor.value).toBe("Alpha [[Obsidian Replacement]] omega"));

    openVaultSpy.mockRestore();
    readNoteSpy.mockRestore();
    getContextSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("replaces selected editor text with an inserted sidebar wiki link", async () => {
    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [
        { path: "Home.md", title: "Home", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "123" },
        { path: "Projects/Obsidian Replacement.md", title: "Obsidian Replacement", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "456" }
      ],
      tree: [
        { kind: "note", name: "Home.md", path: "Home.md", children: [] },
        { kind: "note", name: "Obsidian Replacement.md", path: "Projects/Obsidian Replacement.md", children: [] }
      ],
      obsidianSettings: null
    });

    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Home.md",
      content: "Replace this text",
      revision: "rev-123"
    });
    const getContextSpy = vi.spyOn(vaultApi, "getNoteContext").mockResolvedValue({
      note: {
        path: "Home.md",
        title: "Home",
        tags: [],
        frontmatter: {},
        modifiedAt: "2026-06-01T12:00:00.000Z",
        contentHash: "123",
        content: "Replace this text",
        links: []
      },
      backlinks: [],
      outgoingLinks: []
    });

    vi.spyOn(vaultApi, "getBacklinkSuggestions").mockResolvedValue([
      {
        id: "semantic:Projects/Obsidian Replacement.md",
        sourcePath: "Projects/Obsidian Replacement.md",
        sourceTitle: "Obsidian Replacement",
        targetPath: "Home.md",
        targetTitle: "Home",
        suggestionType: "semantic",
        excerpt: "Related project note.",
        score: 0.84
      }
    ]);

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    const editor = screen.getByTestId("mock-editor") as HTMLTextAreaElement;
    editor.setSelectionRange(8, 12);

    fireEvent.click(screen.getByRole("button", { name: "Link Suggestions" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Insert" })[0]);

    await waitFor(() => expect(editor.value).toBe("Replace [[Obsidian Replacement]] text"));

    openVaultSpy.mockRestore();
    readNoteSpy.mockRestore();
    getContextSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("links remaining plain mentions without nesting existing wiki links", async () => {
    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [
        { path: "Home.md", title: "Home", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "123" },
        { path: "Projects/Obsidian Replacement.md", title: "Obsidian Replacement", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "456" }
      ],
      tree: [
        { kind: "note", name: "Home.md", path: "Home.md", children: [] },
        { kind: "note", name: "Obsidian Replacement.md", path: "Projects/Obsidian Replacement.md", children: [] }
      ],
      obsidianSettings: null
    });

    const content = "Already [[Obsidian Replacement]] and Obsidian Replacement remain.";
    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Home.md",
      content,
      revision: "rev-123"
    });
    const getContextSpy = vi.spyOn(vaultApi, "getNoteContext").mockResolvedValue({
      note: {
        path: "Home.md",
        title: "Home",
        tags: [],
        frontmatter: {},
        modifiedAt: "2026-06-01T12:00:00.000Z",
        contentHash: "123",
        content,
        links: []
      },
      backlinks: [],
      outgoingLinks: []
    });
    const getSuggestionsSpy = vi.spyOn(vaultApi, "getBacklinkSuggestions").mockResolvedValue([]);

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Link Suggestions" }));

    await waitFor(() => expect(screen.getByText("In this Note (1)")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Link All" }));

    const editor = screen.getByTestId("mock-editor") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(editor.value).toBe("Already [[Obsidian Replacement]] and [[Obsidian Replacement]] remain.");
    });

    openVaultSpy.mockRestore();
    readNoteSpy.mockRestore();
    getContextSpy.mockRestore();
    getSuggestionsSpy.mockRestore();
  });

  it("recommends metadata tags and frontmatter properties and applies them", async () => {
    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      llmConfig: { provider: "openai", apiKey: "test-key", model: "gpt-4o" }
    });

    const sendChatMessageSpy = vi.spyOn(llmApi, "sendChatMessage").mockResolvedValue(
      JSON.stringify({
        tags: ["productivity", "obsidian"],
        frontmatter: {
          status: "active",
          priority: "high"
        }
      })
    );

    const applyMetadataSpy = vi.spyOn(vaultApi, "applyNoteMetadata").mockResolvedValue();

    render(<App />);

    // Wait for the app to load
    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    // Locate the "Suggest" button in the AI Metadata Suggestions section
    const suggestBtn = screen.getByRole("button", { name: "Suggest" });
    expect(suggestBtn).toBeTruthy();

    // Click "Suggest"
    fireEvent.click(suggestBtn);

    // Wait for the suggestions card to load and display tags and properties
    await waitFor(() => expect(screen.getByText("#productivity")).toBeTruthy());
    expect(screen.getByText("#obsidian")).toBeTruthy();
    expect(screen.getByText("status:")).toBeTruthy();
    expect(screen.getByText("priority:")).toBeTruthy();

    // Deselect one tag and one property to test toggle
    const productivityCheckbox = screen.getByLabelText(/#productivity/) as HTMLInputElement;
    expect(productivityCheckbox.checked).toBe(true);
    fireEvent.click(productivityCheckbox);
    expect(productivityCheckbox.checked).toBe(false);

    const statusCheckbox = screen.getByLabelText(/status:\s*active/) as HTMLInputElement;
    expect(statusCheckbox.checked).toBe(true);
    fireEvent.click(statusCheckbox);
    expect(statusCheckbox.checked).toBe(false);

    // Apply the selected suggestions
    const applyBtn = screen.getByRole("button", { name: "Apply Selected" });
    fireEvent.click(applyBtn);

    // Verify applyNoteMetadata is called with only the selected/active elements
    await waitFor(() => {
      expect(applyMetadataSpy).toHaveBeenCalledWith(
        "Home.md",
        { priority: "high" },
        ["obsidian"]
      );
    });

    // Cleanup spies
    getVaultConfigSpy.mockRestore();
    sendChatMessageSpy.mockRestore();
    applyMetadataSpy.mockRestore();
  });

  it("fetches local models from Ollama and updates the datalist options", async () => {
    const fetchSpy = vi.spyOn(window, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({
            models: [
              { name: "llama3:latest" },
              { name: "mistral:latest" }
            ]
          })
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ embedding: [0.9, 0.8, 0.7] })
      } as Response;
    });

    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      llmConfig: { provider: "ollama", apiKey: "", model: "llama3", baseUrl: "http://localhost:11434" }
    });

    render(<App />);

    // Wait for the app to load
    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    // Switch to Distill Workspace
    const distillTabBtn = screen.getByRole("button", { name: "Distill" });
    fireEvent.click(distillTabBtn);

    // Switch to Chat sub-tab
    const chatTabBtn = screen.getByRole("button", { name: "Chat with LLM" });
    fireEvent.click(chatTabBtn);

    // Open settings panel
    const settingsBtn = screen.getByRole("button", { name: /LLM Settings/ });
    fireEvent.click(settingsBtn);

    // Locate the "Fetch Models" button
    const fetchModelsBtn = screen.getByRole("button", { name: "Fetch Models" });
    expect(fetchModelsBtn).toBeTruthy();

    // Click "Fetch Models"
    fireEvent.click(fetchModelsBtn);

    // Wait for the fetch call to complete and verify fetch details
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("http://localhost:11434/api/tags"));

    // Verify datalist option values
    await waitFor(() => {
      const datalist = document.getElementById("available-models-list");
      expect(datalist).toBeTruthy();
      const options = Array.from(datalist!.querySelectorAll("option")).map((opt: any) => opt.value);
      expect(options).toContain("llama3:latest");
      expect(options).toContain("mistral:latest");
    });

    // Cleanup spies
    fetchSpy.mockRestore();
    getVaultConfigSpy.mockRestore();
  });

  it("applies a note template using the template dropdown", async () => {
    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      llmConfig: { provider: "openai", apiKey: "test-key", model: "gpt-4o" }
    });

    const sendChatMessageSpy = vi.spyOn(llmApi, "sendChatMessage").mockResolvedValue(
      `---
type: meeting
date: 2026-06-07
participants: Antigravity, User
---

# Meeting Notes
- Discussion item 1
`
    );

    render(<App />);

    // Wait for the app to load
    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    // Locate the select dropdown for templates
    const selectEl = document.querySelector(".templateSelect") as HTMLSelectElement;
    expect(selectEl).toBeTruthy();

    // Select "Meeting Notes" template
    fireEvent.change(selectEl, { target: { value: "Meeting Notes" } });

    // Verify sendChatMessage is called
    await waitFor(() => expect(sendChatMessageSpy).toHaveBeenCalled());

    // Verify status message indicating application
    await waitFor(() => expect(screen.getByText(/Applied template "Meeting Notes"/)).toBeTruthy());

    // Cleanup spies
    getVaultConfigSpy.mockRestore();
    sendChatMessageSpy.mockRestore();
  });

  it("allows filtering nodes in the Graph View by tags and metadata", async () => {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);

    const getGraphSpy = vi.spyOn(vaultApi, "getGraph").mockResolvedValue({
      nodes: [
        { id: "Home.md", label: "Home", tags: ["home", "dashboard"] },
        { id: "Projects/Obsidian Replacement.md", label: "Obsidian Replacement", tags: ["project"] }
      ],
      edges: [
        { id: "edge-1", source: "Home.md", target: "Projects/Obsidian Replacement.md", isManaged: false }
      ],
      focusedPath: "Home.md"
    });

    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [
        { path: "Home.md", title: "Home", tags: ["home", "dashboard"], frontmatter: { status: "active" }, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "123" },
        { path: "Projects/Obsidian Replacement.md", title: "Obsidian Replacement", tags: ["project"], frontmatter: { status: "draft" }, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "456" }
      ],
      tree: []
    });

    render(<App />);

    // Wait for the app to load
    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    // Switch to Graph tab
    const graphTabBtn = screen.getByRole("button", { name: "Graph" });
    fireEvent.click(graphTabBtn);

    // Verify GraphView elements: look for the "Filter Graph" toggle button
    const filterToggleBtn = screen.getByRole("button", { name: /Filter Graph/ });
    expect(filterToggleBtn).toBeTruthy();

    // Toggle the filter panel open
    fireEvent.click(filterToggleBtn);

    // Verify tag checkboxes are displayed in the graph filter panel
    const getFilterCheckbox = (tagName: string) => {
      const labels = Array.from(document.querySelectorAll(".graphFilterTagsList label"));
      const label = labels.find(l => l.textContent === `#${tagName}`);
      return label?.querySelector("input") as HTMLInputElement | undefined;
    };

    await waitFor(() => expect(getFilterCheckbox("home")).toBeTruthy());
    expect(getFilterCheckbox("project")).toBeTruthy();

    // Verify nodes are initially rendered
    const getGraphNode = (path: string) => {
      return document.querySelector(`[data-testid="rf__node-${path}"]`);
    };

    expect(getGraphNode("Home.md")).toBeTruthy();
    expect(getGraphNode("Projects/Obsidian Replacement.md")).toBeTruthy();

    // Uncheck #project tag checkbox to hide "Obsidian Replacement" note
    const projectCheckbox = getFilterCheckbox("project");
    expect(projectCheckbox).toBeTruthy();
    expect(projectCheckbox!.checked).toBe(true);
    fireEvent.click(projectCheckbox!);
    expect(projectCheckbox!.checked).toBe(false);

    // Verify that "Obsidian Replacement" node is removed/hidden
    await waitFor(() => expect(getGraphNode("Projects/Obsidian Replacement.md")).toBeNull());
    expect(getGraphNode("Home.md")).toBeTruthy();

    // Check it back
    fireEvent.click(projectCheckbox!);
    await waitFor(() => expect(getGraphNode("Projects/Obsidian Replacement.md")).toBeTruthy());

    // Now test metadata filter: type status: active to hide status: draft
    const metaInput = document.querySelector(".metadata-filter-input") as HTMLInputElement;
    expect(metaInput).toBeTruthy();
    fireEvent.change(metaInput, { target: { value: "status: active" } });

    // Verify that "Obsidian Replacement" (status: draft) is hidden, and "Home" (status: active) is visible
    await waitFor(() => expect(getGraphNode("Projects/Obsidian Replacement.md")).toBeNull());
    expect(getGraphNode("Home.md")).toBeTruthy();

    // Cleanup spies
    getGraphSpy.mockRestore();
    openVaultSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("indexes semantic recommendations from the newly opened vault notes", async () => {
    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [
        { path: "Home.md", title: "Home", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "home-hash" },
        { path: "Related.md", title: "Related", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "related-hash" }
      ],
      tree: []
    });

    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      llmConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-4o",
        embeddingModel: "text-embedding-3-small"
      }
    });

    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockImplementation(async (path) => ({
      path,
      content: path === "Related.md" ? "Related note content" : "Home note content",
      revision: "1"
    }));

    const saveEmbeddingsCacheSpy = vi.spyOn(vaultApi, "saveEmbeddingsCache").mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(window, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.9, 0.8, 0.7] }] })
    } as Response);

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    await waitFor(() => expect(saveEmbeddingsCacheSpy).toHaveBeenCalled(), { timeout: 1000 });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({ method: "POST" })
    );

    openVaultSpy.mockRestore();
    getVaultConfigSpy.mockRestore();
    readNoteSpy.mockRestore();
    saveEmbeddingsCacheSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it("does not synchronize embeddings for an unchanged note draft", async () => {
    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [
        { path: "Home.md", title: "Home", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "home-hash" }
      ],
      tree: []
    });

    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      llmConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-4o",
        embeddingModel: "text-embedding-3-small"
      }
    });

    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Home.md",
      content: "Home note content",
      revision: "1"
    });

    const saveEmbeddingsCacheSpy = vi.spyOn(vaultApi, "saveEmbeddingsCache").mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(window, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.9, 0.8, 0.7] }] })
    } as Response);

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    fetchSpy.mockClear();
    saveEmbeddingsCacheSpy.mockClear();

    await new Promise((resolve) => setTimeout(resolve, 3200));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(saveEmbeddingsCacheSpy).not.toHaveBeenCalled();

    openVaultSpy.mockRestore();
    getVaultConfigSpy.mockRestore();
    readNoteSpy.mockRestore();
    saveEmbeddingsCacheSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it("synchronizes vector embeddings in the background as note draft content changes", async () => {
    const getGraphSpy = vi.spyOn(vaultApi, "getGraph").mockResolvedValue({
      nodes: [{ id: "Home.md", label: "Home", tags: [] }],
      edges: [],
      focusedPath: "Home.md"
    });

    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [
        { path: "Home.md", title: "Home", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "initial-hash" }
      ],
      tree: []
    });

    const getVaultConfigSpy = vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({
      llmConfig: {
        provider: "openai",
        apiKey: "test-key",
        model: "text-embedding-3-small",
        embeddingModel: "text-embedding-3-small",
        baseUrl: "https://api.openai.com/v1"
      }
    });

    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Home.md",
      content: "Initial content",
      revision: "1"
    });

    const saveEmbeddingsCacheSpy = vi.spyOn(vaultApi, "saveEmbeddingsCache").mockResolvedValue(undefined);

    const fetchSpy = vi.spyOn(window, "fetch").mockImplementation((url) => {
      if (String(url).includes("/embeddings")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [{ embedding: [0.9, 0.8, 0.7] }]
          })
        } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });

    render(<App />);

    // Wait for the app to load using real timers
    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    
    // Select the Home.md note to load it in the editor
    const noteBtn = document.querySelector(".result") as HTMLButtonElement;
    expect(noteBtn).toBeTruthy();
    fireEvent.click(noteBtn);
    
    // Wait for editor to load content
    await waitFor(() => {
      const textarea = screen.getByTestId("mock-editor") as HTMLTextAreaElement;
      expect(textarea.value).toBe("Initial content");
    });

    // Now switch to fake timers to test debounce
    vi.useFakeTimers();

    const textarea = screen.getByTestId("mock-editor") as HTMLTextAreaElement;

    // Simulating typing by changing value
    fireEvent.change(textarea, { target: { value: "Updated content from background sync test" } });
    expect(textarea.value).toBe("Updated content from background sync test");

    // Clear fetchSpy mocks to only measure what happens during debounce
    fetchSpy.mockClear();
    saveEmbeddingsCacheSpy.mockClear();

    // Advance time by 2.9 seconds: should NOT have triggered embedding fetch yet (since debounce is 3s)
    await vi.advanceTimersByTimeAsync(2900);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Advance time past 3 seconds: should trigger fetch and saveEmbeddingsCache
    await vi.advanceTimersByTimeAsync(200);

    // Restore real timers so that waitFor can run its real interval checks
    vi.useRealTimers();

    // Verify it called fetch and saved embeddings cache
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(saveEmbeddingsCacheSpy).toHaveBeenCalled();

    // Cleanup spies
    getGraphSpy.mockRestore();
    openVaultSpy.mockRestore();
    getVaultConfigSpy.mockRestore();
    readNoteSpy.mockRestore();
    saveEmbeddingsCacheSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it("renders global health badge in sidebar, navigates on click, and styles and filters GraphView by health", async () => {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);

    const mockReports = [
      {
        path: "Home.md",
        title: "Home",
        score: 100,
        issues: [],
        isOrphan: false,
        isStale: false,
        isTooBroad: false,
        isDuplicated: false,
        missingSummary: false,
        weakBacklinks: false
      },
      {
        path: "Unhealthy.md",
        title: "Unhealthy Note",
        score: 60,
        issues: ["Orphan note", "Missing summary"],
        isOrphan: true,
        isStale: false,
        isTooBroad: false,
        isDuplicated: false,
        missingSummary: true,
        weakBacklinks: false
      }
    ];

    const getWikiHealthReportSpy = vi.spyOn(vaultApi, "getWikiHealthReport").mockResolvedValue(mockReports);

    const getGraphSpy = vi.spyOn(vaultApi, "getGraph").mockResolvedValue({
      nodes: [
        { id: "Home.md", label: "Home", tags: [] },
        { id: "Unhealthy.md", label: "Unhealthy", tags: [] }
      ],
      edges: [],
      focusedPath: "Home.md"
    });

    const openVaultSpy = vi.spyOn(vaultApi, "openVault").mockResolvedValue({
      rootPath: "Demo Vault",
      notes: [
        { path: "Home.md", title: "Home", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "123" },
        { path: "Unhealthy.md", title: "Unhealthy", tags: [], frontmatter: {}, modifiedAt: "2026-06-01T12:00:00.000Z", contentHash: "456" }
      ],
      tree: []
    });

    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockImplementation(async (path) => {
      return {
        path,
        content: "Dummy content for " + path,
        revision: "1"
      };
    });

    render(<App />);

    // Wait for the app to load
    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    // Verify global health score button is present in the sidebar and reflects the average score (80%)
    const badgeButton = await screen.findByRole("button", { name: "Open Wiki Auditor" });
    expect(badgeButton).toBeTruthy();
    expect(badgeButton.textContent).toContain("80%");
    expect(badgeButton.className).toContain("health-warning");

    // Click badge to go to auditor
    fireEvent.click(badgeButton);
    await waitFor(() => {
      expect(screen.getByText("Wiki Health Scorecard")).toBeTruthy();
    });

    // Go to Graph tab
    const graphTabBtn = screen.getByRole("button", { name: "Graph" });
    fireEvent.click(graphTabBtn);

    // Toggle the filter panel open
    const filterToggleBtn = screen.getByRole("button", { name: /Filter Graph/ });
    fireEvent.click(filterToggleBtn);

    // Verify health checkbox exists
    const healthCheckbox = screen.getByLabelText("Show only notes with health issues") as HTMLInputElement;
    expect(healthCheckbox).toBeTruthy();
    expect(healthCheckbox.checked).toBe(false);

    const getGraphNode = (path: string) => {
      return document.querySelector(`[data-testid="rf__node-${path}"]`);
    };

    // Verify both nodes are rendered on the screen
    await waitFor(() => {
      expect(getGraphNode("Home.md")).toBeTruthy();
      expect(getGraphNode("Unhealthy.md")).toBeTruthy();
    });

    // Verify health styling classes (Unhealthy.md should have health-critical since 60 < 70)
    const unhealthyNodeEl = getGraphNode("Unhealthy.md");
    expect(unhealthyNodeEl?.className).toContain("health-critical");

    // Toggle "Show only notes with health issues" checkbox
    fireEvent.click(healthCheckbox);
    expect(healthCheckbox.checked).toBe(true);

    // Verify Home.md is hidden/removed while Unhealthy.md remains
    await waitFor(() => expect(getGraphNode("Home.md")).toBeNull());
    expect(getGraphNode("Unhealthy.md")).toBeTruthy();

    // Cleanup spies
    getWikiHealthReportSpy.mockRestore();
    getGraphSpy.mockRestore();
    openVaultSpy.mockRestore();
    readNoteSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("selects graph ghost nodes in place and keeps them out of link management dropdowns", async () => {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);

    const getGraphSpy = vi.spyOn(vaultApi, "getGraph").mockResolvedValue({
      nodes: [
        { id: "Home.md", label: "Home", tags: [], kind: "note" },
        { id: "unresolved:missing page", label: "Missing Page", tags: [], kind: "unresolved" }
      ],
      edges: [
        { id: "Home.md->unresolved:missing page", source: "Home.md", target: "unresolved:missing page", isManaged: false }
      ],
      focusedPath: "Home.md"
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));

    const getGraphNode = (path: string) => document.querySelector(`[data-testid="rf__node-${path}"]`);
    await waitFor(() => expect(getGraphNode("unresolved:missing page")).toBeTruthy());

    const selects = Array.from(document.querySelectorAll("select")) as HTMLSelectElement[];
    const graphSelects = selects.filter((select) => {
      const first = select.querySelector("option")?.textContent;
      return first === "Add link from current note" || first === "Remove managed link";
    });
    expect(graphSelects.length).toBe(2);
    for (const select of graphSelects) {
      const optionValues = Array.from(select.querySelectorAll("option")).map((option) => option.value);
      expect(optionValues).not.toContain("unresolved:missing page");
    }

    fireEvent.click(getGraphNode("unresolved:missing page")!);

    await waitFor(() => expect(screen.getByText("Unresolved Page")).toBeTruthy());
    expect(screen.getAllByText(/Missing Page/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Open in Auditor" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Draft AI Stub" })).toBeTruthy();
    expect(screen.queryByText("Wiki Health Scorecard")).toBeNull();

    getGraphSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("displays the Git Workspace, lists changes, reviews diffs, stages, and commits", async () => {
    const getGitStatusSpy = vi.spyOn(vaultApi, "getGitStatus").mockResolvedValue({
      isRepo: true,
      autoGitEnabled: false,
      branch: "feature-branch",
      hasChanges: true,
      hasConflicts: false
    });
    const getGitChangesSpy = vi.spyOn(vaultApi, "getGitChanges").mockResolvedValue([
      { path: "ModifiedNote.md", status: "modified", staged: false },
      { path: "StagedNote.md", status: "modified", staged: true },
      { path: "UntrackedNote.md", status: "untracked", staged: false }
    ]);
    const getGitDiffSpy = vi.spyOn(vaultApi, "getGitDiff").mockResolvedValue(
      "--- a/ModifiedNote.md\n+++ b/ModifiedNote.md\n@@ -1,1 +1,2 @@\n-Old Line\n+New Line\n+Another Line"
    );
    const gitStageAllSpy = vi.spyOn(vaultApi, "gitStageAll").mockResolvedValue();
    const gitCommitSpy = vi.spyOn(vaultApi, "gitCommit").mockResolvedValue("[feature-branch abc1234] Test Commit Message");

    render(<App />);

    // Open Distill View
    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Distill" }));

    // Click on Git Workspace Tab
    const gitTabBtn = screen.getByRole("button", { name: "Git Workspace" });
    fireEvent.click(gitTabBtn);

    // Verify repository status info is rendered
    await waitFor(() => expect(screen.getByText("feature-branch")).toBeTruthy());
    expect(screen.getByText("Staged Changes (1)")).toBeTruthy();
    expect(screen.getByText("Unstaged Changes (2)")).toBeTruthy();
    expect(screen.getByText("ModifiedNote.md")).toBeTruthy();
    expect(screen.getByText("StagedNote.md")).toBeTruthy();

    // Select ModifiedNote.md to load diff
    const modifiedItem = screen.getByText("ModifiedNote.md");
    fireEvent.click(modifiedItem);

    // Verify getGitDiff was called and rendering color styled lines
    await waitFor(() => {
      expect(getGitDiffSpy).toHaveBeenCalledWith("ModifiedNote.md", false);
      expect(screen.getByText("+New Line")).toBeTruthy();
      expect(screen.getByText("-Old Line")).toBeTruthy();
    });

    // Test Stage All
    const stageAllBtn = screen.getByRole("button", { name: "Stage All" }) as HTMLButtonElement;
    fireEvent.click(stageAllBtn);
    expect(gitStageAllSpy).toHaveBeenCalled();

    // Wait for the loading state to finish (Stage All button becomes enabled again)
    await waitFor(() => {
      expect(stageAllBtn.disabled).toBe(false);
    });

    // Test Commit
    const commitMsgInput = screen.getByPlaceholderText("Type a commit message...");
    fireEvent.change(commitMsgInput, { target: { value: "Test Commit Message" } });

    // Now wait for the button to be enabled and click it
    const commitBtn = screen.getByRole("button", { name: "Commit Selected (1)" }) as HTMLButtonElement;
    expect(commitBtn.disabled).toBe(false);
    fireEvent.click(commitBtn);

    await waitFor(() => {
      expect(gitCommitSpy).toHaveBeenCalledWith("Test Commit Message");
    });

    // Clean up mocks
    getGitStatusSpy.mockRestore();
    getGitChangesSpy.mockRestore();
    getGitDiffSpy.mockRestore();
    gitStageAllSpy.mockRestore();
    gitCommitSpy.mockRestore();
  });

  it("renders Git diffs with file headers, line numbers, and collapsible hunks", async () => {
    const getGitStatusSpy = vi.spyOn(vaultApi, "getGitStatus").mockResolvedValue({
      isRepo: true,
      autoGitEnabled: false,
      branch: "feature-branch",
      hasChanges: true,
      hasConflicts: false
    });
    const getGitChangesSpy = vi.spyOn(vaultApi, "getGitChanges").mockResolvedValue([
      { path: "Docs.md", status: "modified", staged: false }
    ]);
    const getGitDiffSpy = vi.spyOn(vaultApi, "getGitDiff").mockResolvedValue(
      [
        "diff --git a/Docs.md b/Docs.md",
        "index 1111111..2222222 100644",
        "--- a/Docs.md",
        "+++ b/Docs.md",
        "@@ -1,2 +1,3 @@ intro",
        " line one",
        "-old two",
        "+new two",
        "+new three",
        "@@ -10,2 +11,2 @@ outro",
        " context ten",
        "-old eleven",
        "+new eleven",
        "@@ -20,2 +21,2 @@ markdown",
        "--- old heading",
        "+++ new heading",
        "diff --git a/Other.md b/Other.md",
        "index 3333333..4444444 100644",
        "--- a/Other.md",
        "+++ b/Other.md",
        "@@ -1,2 +1,3 @@ intro",
        " other one",
        "-old other",
        "+new other",
        "+extra other"
      ].join("\n")
    );

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Distill" }));
    fireEvent.click(screen.getByRole("button", { name: "Git Workspace" }));

    await waitFor(() => expect(screen.getByText("Docs.md")).toBeTruthy());
    fireEvent.click(screen.getByText("Docs.md"));

    await waitFor(() => {
      expect(getGitDiffSpy).toHaveBeenCalledWith("Docs.md", false);
      expect(document.querySelector(".gitDiffFileHeader")?.textContent).toContain("a/Docs.md");
      expect(document.querySelector(".gitDiffFileHeader")?.textContent).toContain("b/Docs.md");
      expect(document.querySelector(".gitDiffFileHeader")?.textContent).toContain("3 hunks");
    });
    expect(screen.queryByRole("button", { name: /Collapse hunk unified diff/ })).toBeNull();

    const oldLineNumbers = Array.from(document.querySelectorAll(".gitDiffLineNumber.old")).map((el) => el.textContent);
    const newLineNumbers = Array.from(document.querySelectorAll(".gitDiffLineNumber.new")).map((el) => el.textContent);
    expect(oldLineNumbers).toContain("1");
    expect(oldLineNumbers).toContain("2");
    expect(newLineNumbers).toContain("1");
    expect(newLineNumbers).toContain("2");
    expect(newLineNumbers).toContain("3");

    const repeatedRangeHunkButtons = screen.getAllByRole("button", { name: /Collapse hunk -1,2 \+1,3/ });
    fireEvent.click(repeatedRangeHunkButtons[0]);
    await waitFor(() => expect(screen.queryByText("-old two")).toBeNull());
    expect(screen.getByText("-old eleven")).toBeTruthy();
    expect(screen.getByText("-old other")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Expand hunk -1,2 \+1,3/ }));
    expect(screen.getByText("-old two")).toBeTruthy();
    expect(screen.getByText("--- old heading")).toBeTruthy();
    expect(screen.getByText("+++ new heading")).toBeTruthy();

    getGitStatusSpy.mockRestore();
    getGitChangesSpy.mockRestore();
    getGitDiffSpy.mockRestore();
  });

  it("stages and unstages individual files, auto-opens and styles console logs, and handles clean state", async () => {
    const getGitStatusSpy = vi.spyOn(vaultApi, "getGitStatus").mockResolvedValue({
      isRepo: true,
      autoGitEnabled: false,
      branch: "main",
      hasChanges: true,
      hasConflicts: false
    });
    
    const getGitChangesSpy = vi.spyOn(vaultApi, "getGitChanges").mockResolvedValue([
      { path: "ModifiedNote.md", status: "modified", staged: false }
    ]);
    
    const getGitDiffSpy = vi.spyOn(vaultApi, "getGitDiff").mockResolvedValue("diff content");
    const gitStageFileSpy = vi.spyOn(vaultApi, "gitStageFile").mockResolvedValue();
    const gitUnstageFileSpy = vi.spyOn(vaultApi, "gitUnstageFile").mockResolvedValue();

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Distill" }));
    fireEvent.click(screen.getByRole("button", { name: "Git Workspace" }));

    await waitFor(() => expect(screen.getByText("ModifiedNote.md")).toBeTruthy());
    
    const stageBtn = screen.getByTitle("Stage this file");
    expect(stageBtn).toBeTruthy();
    
    getGitChangesSpy.mockResolvedValue([
      { path: "ModifiedNote.md", status: "modified", staged: true }
    ]);
    
    fireEvent.click(stageBtn);
    expect(gitStageFileSpy).toHaveBeenCalledWith("ModifiedNote.md");
    
    await waitFor(() => expect(screen.getByTitle("Unstage this file")).toBeTruthy());

    const unstageBtn = screen.getByTitle("Unstage this file");
    getGitChangesSpy.mockResolvedValue([
      { path: "ModifiedNote.md", status: "modified", staged: false }
    ]);
    
    fireEvent.click(unstageBtn);
    expect(gitUnstageFileSpy).toHaveBeenCalledWith("ModifiedNote.md");
    await waitFor(() => expect(screen.getByTitle("Stage this file")).toBeTruthy());

    getGitChangesSpy.mockResolvedValue([]);
    getGitStatusSpy.mockResolvedValue({
      isRepo: true,
      autoGitEnabled: false,
      branch: "main",
      hasChanges: false,
      hasConflicts: false
    });
    
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    
    await waitFor(() => {
      expect(screen.getByText("All changes committed")).toBeTruthy();
      expect(screen.getByText("Your workspace is clean. No modifications detected.")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Pull" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Push" })).toBeTruthy();

    getGitStatusSpy.mockRestore();
    getGitChangesSpy.mockRestore();
    getGitDiffSpy.mockRestore();
    gitStageFileSpy.mockRestore();
    gitUnstageFileSpy.mockRestore();
  });

  it("auto-opens the console output panel and styles it red if log contains error or fatal warnings", async () => {
    const getGitStatusSpy = vi.spyOn(vaultApi, "getGitStatus").mockResolvedValue({
      isRepo: true,
      autoGitEnabled: false,
      branch: "main",
      hasChanges: true,
      hasConflicts: false
    });
    const getGitChangesSpy = vi.spyOn(vaultApi, "getGitChanges").mockResolvedValue([
      { path: "ModifiedNote.md", status: "modified", staged: false }
    ]);
    
    const gitStageAllSpy = vi.spyOn(vaultApi, "gitStageAll").mockRejectedValue(new Error("fatal: something went wrong"));

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Distill" }));
    fireEvent.click(screen.getByRole("button", { name: "Git Workspace" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Stage All" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Stage All" }));

    await waitFor(() => {
      expect(screen.getByText("Command Output Console")).toBeTruthy();
      expect(screen.getByText(/fatal: something went wrong/)).toBeTruthy();
      
      const consoleCard = document.querySelector(".gitConsoleCard");
      expect(consoleCard?.className).toContain("hasError");
    });

    getGitStatusSpy.mockRestore();
    getGitChangesSpy.mockRestore();
    gitStageAllSpy.mockRestore();
  });

  it("displays conflict warning card, banner, groups conflicted files, and disables pull/push/commit buttons", async () => {
    const getGitStatusSpy = vi.spyOn(vaultApi, "getGitStatus").mockResolvedValue({
      isRepo: true,
      autoGitEnabled: false,
      branch: "main",
      hasChanges: true,
      hasConflicts: true
    });
    const getGitChangesSpy = vi.spyOn(vaultApi, "getGitChanges").mockResolvedValue([
      { path: "Home.md", status: "conflict", staged: false }
    ]);
    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Home.md",
      content: "<<<<<<<\nmaster content\n=======\nother content\n>>>>>>>\n",
      revision: "rev123"
    });
    const getGitDiffSpy = vi.spyOn(vaultApi, "getGitDiff").mockResolvedValue("<<<<<<<\n+master content\n=======\n+other content\n>>>>>>>\n");

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    // 1. Check Editor Banner (select the conflicted note)
    const noteNode = screen.getByRole("button", { name: "Home.md" });
    fireEvent.click(noteNode);

    await waitFor(() => {
      expect(screen.getByText(/This note has unresolved merge conflicts/)).toBeTruthy();
    });

    // 2. Open Git Workspace and check conflict UI
    fireEvent.click(screen.getByRole("button", { name: "Distill" }));
    fireEvent.click(screen.getByRole("button", { name: "Git Workspace" }));

    await waitFor(() => {
      expect(screen.getByText("Unresolved Conflicts (1)")).toBeTruthy();
      expect(screen.getAllByText("Home.md").length).toBeGreaterThan(0);
    });

    // Verify warning card in sidebar
    expect(screen.getByText(/Conflict Warning/)).toBeTruthy();
    expect(screen.getByText(/Repository has unresolved merge conflicts/)).toBeTruthy();

    // Verify commit and pull/push buttons are disabled
    const commitBtn = screen.getByRole("button", { name: /Commit Selected/ });
    const pullBtn = screen.getByRole("button", { name: "Pull" });
    const pushBtn = screen.getByRole("button", { name: "Push" });

    expect(commitBtn.getAttribute("disabled")).not.toBeNull();
    expect(pullBtn.getAttribute("disabled")).not.toBeNull();
    expect(pushBtn.getAttribute("disabled")).not.toBeNull();

    // Clean up
    getGitStatusSpy.mockRestore();
    getGitChangesSpy.mockRestore();
    readNoteSpy.mockRestore();
    getGitDiffSpy.mockRestore();
  });
});


