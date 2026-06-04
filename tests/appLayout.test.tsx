import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/ui/App";

describe("App layout", () => {
  it("starts in split mode with editor and preview visible together", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("Demo Vault")).toBeTruthy());

    expect(screen.getByRole("button", { name: "Split" }).className).toContain("active");
    expect(document.querySelector(".editorSurface")).toBeTruthy();
    expect(document.querySelector(".previewSurface")?.textContent).toContain("Welcome to the local vault.");
  });
});
