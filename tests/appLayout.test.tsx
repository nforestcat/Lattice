import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/ui/App";
import { vaultApi } from "../src/api";

describe("App layout", () => {
  it("starts in split mode with editor and preview visible together", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    expect(screen.getByRole("button", { name: "Split" }).className).toContain("active");
    expect(document.querySelector(".editorSurface")).toBeTruthy();
    expect(document.querySelector(".previewSurface")?.textContent).toContain("Welcome to the local vault.");
  });

  it("handles token limit config overflows and auto-prunes lowest score recommended notes", async () => {
    // Stub getContextBundleCandidates to return controlled focus and recommended notes
    const candidatesSpy = vi.spyOn(vaultApi, "getContextBundleCandidates").mockResolvedValue([
      { path: "Home.md", title: "Home", reason: "Focus", reasonDetail: "Focus note", score: 10, excerpt: "Focus excerpt", tokenEstimate: 50, selected: true, characterCount: 100 },
      { path: "Rec1.md", title: "Rec1", reason: "Recommended", reasonDetail: "Rec1 detail", score: 5, excerpt: "Rec1 excerpt", tokenEstimate: 30, selected: false, characterCount: 60 },
      { path: "Rec2.md", title: "Rec2", reason: "Recommended", reasonDetail: "Rec2 detail", score: 7, excerpt: "Rec2 excerpt", tokenEstimate: 40, selected: false, characterCount: 80 }
    ]);

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
});
