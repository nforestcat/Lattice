import { describe, expect, it, vi } from "vitest";
import type { ProposedEdit } from "../src/api/types";
import { findAmbiguousUpdateAnchor } from "../src/ui/proposedEditGuards";

describe("proposed edit guards", () => {
  it("finds the first update edit whose target content appears more than once", async () => {
    const edits: ProposedEdit[] = [
      {
        id: "edit-1",
        type: "update",
        path: "Home.md",
        targetContent: "repeat me",
        replacementContent: "done",
        applied: false,
      },
      {
        id: "edit-2",
        type: "create",
        path: "New.md",
        content: "# New",
        applied: false,
      },
    ];
    const readNote = vi.fn().mockResolvedValue({
      content: "repeat me\n\nmiddle\n\nrepeat me",
    });

    const result = await findAmbiguousUpdateAnchor(edits, readNote);

    expect(result).toEqual({
      path: "Home.md",
      targetContent: "repeat me",
      occurrences: 2,
    });
    expect(readNote).toHaveBeenCalledWith("Home.md");
  });
});
