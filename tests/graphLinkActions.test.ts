import { describe, expect, it, vi } from "vitest";
import { deleteManagedGraphLinkAfterConfirmation } from "../src/ui/graphLinkActions";
import type { LinkMutationResult } from "../src/api/types";

const linkMutationResult: LinkMutationResult = {
  note: {
    path: "Home.md",
    content: "# Home",
    revision: "rev-2",
  },
  graph: {
    focusedPath: "Home.md",
    nodes: [],
    edges: [],
  },
};

describe("deleteManagedGraphLinkAfterConfirmation", () => {
  it("does not delete when confirmation is rejected", async () => {
    const confirmAction = vi.fn().mockResolvedValue(false);
    const deleteManagedGraphLink = vi.fn().mockResolvedValue(linkMutationResult);

    const result = await deleteManagedGraphLinkAfterConfirmation(
      "Home.md",
      "Projects/Obsidian Replacement.md",
      deleteManagedGraphLink,
      confirmAction,
    );

    expect(result).toBeNull();
    expect(confirmAction).toHaveBeenCalledWith(
      'Remove managed graph link to "Projects/Obsidian Replacement.md"?',
      "Delete Link",
    );
    expect(deleteManagedGraphLink).not.toHaveBeenCalled();
  });

  it("deletes after confirmation", async () => {
    const confirmAction = vi.fn().mockResolvedValue(true);
    const deleteManagedGraphLink = vi.fn().mockResolvedValue(linkMutationResult);

    const result = await deleteManagedGraphLinkAfterConfirmation(
      "Home.md",
      "Projects/Obsidian Replacement.md",
      deleteManagedGraphLink,
      confirmAction,
    );

    expect(result).toBe(linkMutationResult);
    expect(deleteManagedGraphLink).toHaveBeenCalledWith("Home.md", "Projects/Obsidian Replacement.md");
  });
});
