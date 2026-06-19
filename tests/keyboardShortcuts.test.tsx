import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultApi } from "../src/api";
import { App } from "../src/ui/App";

let editorExtensionCount = 0;

vi.mock("@uiw/react-codemirror", () => ({
  default: (props: {
    readonly value?: string;
    readonly extensions?: readonly unknown[];
    readonly onChange?: (value: string) => void;
  }) => {
    editorExtensionCount = props.extensions?.length ?? 0;
    return (
      <textarea
        aria-label="Note editor"
        value={props.value ?? ""}
        onChange={(event) => props.onChange?.(event.target.value)}
      />
    );
  },
}));

describe("keyboard shortcuts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    editorExtensionCount = 0;
  });

  it("saves the active note with Ctrl+S", async () => {
    const saveNoteSpy = vi.spyOn(vaultApi, "saveNote");
    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Note editor"), {
      target: { value: "# Updated from shortcut" },
    });

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    await waitFor(() => {
      expect(saveNoteSpy).toHaveBeenCalledWith(
        "Home.md",
        "# Updated from shortcut",
        expect.any(String),
      );
    });
  });

  it("switches views with Alt plus number shortcuts", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());
    fireEvent.keyDown(window, { key: "3", altKey: true });

    expect(screen.getByRole("button", { name: "Preview" }).className).toContain("active");
    expect(document.querySelector(".editorSurface")).toBeNull();
    expect(document.querySelector(".previewSurface")).toBeTruthy();
  });

  it("moves to the next note with Alt+ArrowDown", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Home.md" })).toBeTruthy());
    fireEvent.keyDown(window, { key: "ArrowDown", altKey: true });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Obsidian Replacement.md" }).closest(".treeRow")?.className,
      ).toContain("active");
    });
  });

  it("adds a keyboard keymap extension to CodeMirror", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    expect(editorExtensionCount).toBeGreaterThan(1);
  });
});
