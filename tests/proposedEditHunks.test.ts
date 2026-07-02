import { describe, expect, it } from "vitest";
import type { ProposedEdit } from "../src/api/types";
import {
  buildProposedEditHunkSelection,
  getSelectableProposedEditHunks,
} from "../src/ui/proposedEditHunks";

function updateEdit(): ProposedEdit {
  return {
    id: "edit-1",
    type: "update",
    path: "Note.md",
    targetContent: [
      "title",
      "old first",
      "",
      "middle",
      "old second",
      "end",
    ].join("\n"),
    replacementContent: [
      "title",
      "new first",
      "",
      "middle",
      "new second",
      "end",
    ].join("\n"),
    applied: false,
    checked: true,
  };
}

describe("proposed edit hunk selection", () => {
  it("splits separated update changes into selectable hunks", () => {
    const hunks = getSelectableProposedEditHunks(updateEdit());

    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ id: "hunk-1", removeCount: 1, addCount: 1 });
    expect(hunks[1]).toMatchObject({ id: "hunk-2", removeCount: 1, addCount: 1 });
  });

  it("builds a selected edit plus remaining edit for partial application", () => {
    const selection = buildProposedEditHunkSelection(updateEdit(), ["hunk-1"]);

    expect(selection?.editToApply.replacementContent).toBe([
      "title",
      "new first",
      "",
      "middle",
      "old second",
      "end",
    ].join("\n"));
    expect(selection?.remainingEdit).toMatchObject({
      targetContent: [
        "title",
        "new first",
        "",
        "middle",
        "old second",
        "end",
      ].join("\n"),
      replacementContent: [
        "title",
        "new first",
        "",
        "middle",
        "new second",
        "end",
      ].join("\n"),
      applied: false,
      checked: true,
    });
  });

  it("returns no remaining edit when every hunk is selected", () => {
    const selection = buildProposedEditHunkSelection(updateEdit(), ["hunk-1", "hunk-2"]);

    expect(selection?.remainingEdit).toBeNull();
    expect(selection?.editToApply.replacementContent).toBe(updateEdit().replacementContent);
  });
});
