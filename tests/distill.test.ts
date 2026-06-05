import { describe, expect, it } from "vitest";
import { parseProposedEdits } from "../src/core/distillParser";

describe("Distill Parser", () => {
  it("parses create edit correctly", () => {
    const raw = `
      Some introduction text.
      <propose_edit type="create" path="Projects/NewProject.md">
        <reason>Create a new project note.</reason>
        <content># New Project\nThis is a new project.</content>
      </propose_edit>
    `;
    const result = parseProposedEdits(raw);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("create");
    expect(result[0].path).toBe("Projects/NewProject.md");
    expect(result[0].reason).toBe("Create a new project note.");
    expect(result[0].content).toBe("# New Project\nThis is a new project.");
  });

  it("parses update edit with target and replacement content including CDATA", () => {
    const raw = `
      <propose_edit type="update" path="Home.md">
        <reason>Add link.</reason>
        <target_content><![CDATA[Explore [[Projects/Obsidian Replacement]].]]></target_content>
        <replacement_content><![CDATA[Explore [[Projects/Obsidian Replacement]] and [[Projects/NewProject]].]]></replacement_content>
      </propose_edit>
    `;
    const result = parseProposedEdits(raw);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("update");
    expect(result[0].path).toBe("Home.md");
    expect(result[0].reason).toBe("Add link.");
    expect(result[0].targetContent).toBe("Explore [[Projects/Obsidian Replacement]].");
    expect(result[0].replacementContent).toBe("Explore [[Projects/Obsidian Replacement]] and [[Projects/NewProject]].");
  });

  it("handles malformed XML and skips invalid types", () => {
    const raw = `
      <propose_edit type="invalid" path="Home.md">
        <reason>Skip this</reason>
      </propose_edit>
      <propose_edit type="delete" path="Temp.md">
        <reason>Delete temp note</reason>
      </propose_edit>
    `;
    const result = parseProposedEdits(raw);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("delete");
    expect(result[0].path).toBe("Temp.md");
    expect(result[0].reason).toBe("Delete temp note");
  });
});
