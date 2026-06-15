import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import { vaultApi } from "../src/api";
import { App } from "../src/ui/App";

type MockEditorRef = MutableRefObject<{
  view: {
    readonly state: {
      readonly selection: { readonly main: { readonly from: number; readonly to: number } };
      update: (transaction: unknown) => unknown;
    };
    dispatch: (transaction: { readonly changes: { readonly from: number; readonly to: number; readonly insert: string } }) => void;
    focus: () => void;
  };
} | null>;

type MockCodeMirrorProps = {
  readonly ref?: MockEditorRef;
  readonly value?: string;
  readonly onChange?: (value: string) => void;
};

vi.mock("@uiw/react-codemirror", () => {
  return {
    default: (props: MockCodeMirrorProps) => {
      if (props.ref) {
        props.ref.current = {
          view: {
            get state() {
              const editor = document.querySelector("[data-testid='mock-editor']") as HTMLTextAreaElement | null;
              const value = props.value ?? "";
              const from = editor?.selectionStart ?? value.length;
              const to = editor?.selectionEnd ?? from;
              return {
                selection: { main: { from, to } },
                update: (transaction: unknown) => transaction,
              };
            },
            dispatch: (transaction) => {
              const value = props.value ?? "";
              const { from, to, insert } = transaction.changes;
              props.onChange?.(`${value.slice(0, from)}${insert}${value.slice(to)}`);
            },
            focus: () => {},
          },
        };
      }

      return (
        <textarea
          data-testid="mock-editor"
          className="mock-editor"
          value={props.value ?? ""}
          onChange={(event) => props.onChange?.(event.target.value)}
          style={{ width: "100%", height: "100%" }}
        />
      );
    },
  };
});

describe("Review Queue", () => {
  it("applies a proposed create edit through the queue when Apply is clicked", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const createNoteSpy = vi.spyOn(vaultApi, "createNote").mockResolvedValue({
      vault: { rootPath: "Demo Vault", notes: [], tree: [] },
      selectedPath: "Research/Compounding Memory.md",
    });
    const saveNoteSpy = vi.spyOn(vaultApi, "saveNote").mockResolvedValue({
      saved: true,
      revision: "rev-new",
      conflict: false,
      snapshotId: null,
      gitCommit: null,
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Distill" }));
    fireEvent.click(screen.getByText("Load Mock Proposal"));
    fireEvent.click(screen.getByText("Propose Wiki Edits"));

    await waitFor(() => expect(screen.getByText("Research/Compounding Memory.md")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "검토 대기열" }));
    const createCardTitle = await screen.findByText("create: Research/Compounding Memory.md");
    const createCard = createCardTitle.closest("[data-testid='review-queue-item']");
    expect(createCard).toBeTruthy();

    fireEvent.click(within(createCard as HTMLElement).getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith("Apply 1 proposed wiki edit(s)?");
      expect(createNoteSpy).toHaveBeenCalledWith("Research", "Compounding Memory");
      expect(saveNoteSpy).toHaveBeenCalledWith(
        "Research/Compounding Memory.md",
        expect.stringContaining("# Compounding Memory"),
        "",
      );
    });

    confirmSpy.mockRestore();
    createNoteSpy.mockRestore();
    saveNoteSpy.mockRestore();
  });
});
