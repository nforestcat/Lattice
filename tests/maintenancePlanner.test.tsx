import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultApi } from "../src/api";
import { sendChatMessage } from "../src/api/llm";
import type { LlmConfig, ReviewQueueItem } from "../src/api/types";
import { useMaintenancePlanner } from "../src/ui/hooks/useMaintenancePlanner";

vi.mock("../src/api/llm", () => ({
  sendChatMessage: vi.fn(),
}));

const llmConfig: LlmConfig = {
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  baseUrl: "http://localhost:1234/v1",
};

function missingSummaryItem(): ReviewQueueItem {
  return {
    id: "health-Notes/Long.md-missingSummary",
    sourceId: "Notes/Long.md",
    kind: "missing_summary",
    status: "new",
    path: "Notes/Long.md",
    title: "Long Note: missingSummary",
    gitStaged: false,
    createdAt: 0,
    sourceRef: {
      path: "Notes/Long.md",
      title: "Long Note",
      score: 70,
      issues: ["missingSummary"],
      isOrphan: false,
      isStale: false,
      isTooBroad: false,
      isDuplicated: false,
      missingSummary: true,
      weakBacklinks: false,
    },
    suggestionKind: "summary",
  };
}

describe("useMaintenancePlanner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(sendChatMessage).mockReset();
  });

  it("builds maintenance prompts from the note content instead of the health report shell", async () => {
    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Notes/Long.md",
      content: "# Long Note\nActual body that the planner must summarize.",
      revision: "rev-current",
    });
    vi.spyOn(vaultApi, "getVaultConfig").mockResolvedValue({});
    const saveVaultConfigSpy = vi.spyOn(vaultApi, "saveVaultConfig").mockResolvedValue(undefined);
    vi.mocked(sendChatMessage).mockResolvedValue("A useful generated summary.");
    const { result } = renderHook(() => useMaintenancePlanner());

    await act(async () => {
      await result.current.generate(missingSummaryItem(), llmConfig);
    });

    expect(readNoteSpy).toHaveBeenCalledWith("Notes/Long.md");
    expect(sendChatMessage).toHaveBeenCalledWith(
      llmConfig,
      [
        {
          role: "user",
          content: expect.stringContaining("Actual body that the planner must summarize."),
        },
      ],
    );
    expect(saveVaultConfigSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        maintenanceSuggestions: expect.objectContaining({
          "health-Notes/Long.md-missingSummary": expect.objectContaining({
            proposed: "A useful generated summary.",
          }),
          "Notes/Long.md::summary": expect.objectContaining({
            proposed: "A useful generated summary.",
          }),
        }),
      }),
    );
    await waitFor(() => expect(result.current.suggestions["health-Notes/Long.md-missingSummary"]).toBe("A useful generated summary."));
  });
});
