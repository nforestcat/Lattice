import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictResolver } from "../src/ui/components/ConflictResolver";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: any[]) => invokeMock(...args)
}));

const STALE_FILE = {
  path: "stale.md",
  hunks: [{ index: 0, ours: "old ours", theirs: "old theirs", resolved: false, resolution: null, manualContent: null }]
};

const FRESH_FILE = {
  path: "fresh.md",
  hunks: [{ index: 0, ours: "new ours", theirs: "new theirs", resolved: false, resolution: null, manualContent: null }]
};

describe("ConflictResolver forceFresh", () => {
  afterEach(() => {
    invokeMock.mockReset();
  });

  it("uses persisted state when forceFresh is false (resume case)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_note") {
        return Promise.resolve(JSON.stringify({ files: [STALE_FILE], savedAt: new Date().toISOString() }));
      }
      if (cmd === "get_conflict_files") {
        return Promise.resolve([FRESH_FILE]);
      }
      return Promise.resolve(null);
    });

    render(<ConflictResolver open={true} onClose={() => {}} onResolved={() => {}} forceFresh={false} />);

    await waitFor(() => {
      expect(screen.getByText("stale.md")).toBeTruthy();
    });
    expect(screen.queryByText("fresh.md")).toBeNull();
  });

  it("ignores stale persisted state and loads current conflicts when forceFresh is true", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_note") {
        return Promise.resolve(JSON.stringify({ files: [STALE_FILE], savedAt: new Date().toISOString() }));
      }
      if (cmd === "get_conflict_files") {
        return Promise.resolve([FRESH_FILE]);
      }
      return Promise.resolve(null);
    });

    render(<ConflictResolver open={true} onClose={() => {}} onResolved={() => {}} forceFresh={true} />);

    await waitFor(() => {
      expect(screen.getByText("fresh.md")).toBeTruthy();
    });
    expect(screen.queryByText("stale.md")).toBeNull();

    // read_note must never be called when forceFresh is true
    expect(invokeMock).not.toHaveBeenCalledWith("read_note", expect.anything());
  });

  it("does not persist (save_note) before the fresh load completes", async () => {
    let resolveGetConflictFiles: (value: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_conflict_files") {
        return new Promise((resolve) => {
          resolveGetConflictFiles = resolve;
        });
      }
      if (cmd === "save_note") {
        return Promise.resolve();
      }
      return Promise.resolve(null);
    });

    render(<ConflictResolver open={true} onClose={() => {}} onResolved={() => {}} forceFresh={true} />);

    // While get_conflict_files is still pending, no save_note write-back should occur.
    expect(invokeMock).not.toHaveBeenCalledWith("save_note", expect.anything());

    resolveGetConflictFiles([FRESH_FILE]);

    await waitFor(() => {
      expect(screen.getByText("fresh.md")).toBeTruthy();
    });
  });
});

describe("ConflictResolver progress bar semantics", () => {
  afterEach(() => {
    invokeMock.mockReset();
  });

  it("does not advance progress when all hunks are resolved but the file is not yet marked", async () => {
    const singleHunkFile = {
      path: "one.md",
      hunks: [{ index: 0, ours: "ours", theirs: "theirs", resolved: false, resolution: null, manualContent: null }]
    };
    const resolvedHunkFile = { ...singleHunkFile, hunks: [{ ...singleHunkFile.hunks[0], resolved: true, resolution: "ours" }] };

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_conflict_files") return Promise.resolve([singleHunkFile]);
      if (cmd === "resolve_conflict_hunk") return Promise.resolve(resolvedHunkFile);
      return Promise.resolve(null);
    });

    render(<ConflictResolver open={true} onClose={() => {}} onResolved={() => {}} forceFresh={true} />);

    await waitFor(() => {
      expect(screen.getByText("0/1 파일 해결됨")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Accept Ours" }));

    await waitFor(() => {
      const markButton = screen.getByRole("button", { name: "Mark as Resolved → git add" }) as HTMLButtonElement;
      expect(markButton.disabled).toBe(false);
    });

    // hunks are all resolved, but the file is not marked yet -> progress must stay at 0/1
    expect(screen.getByText("0/1 파일 해결됨")).toBeTruthy();
  });

  it("advances progress to N/N only once the resolved file is explicitly marked", async () => {
    const singleHunkFile = {
      path: "one.md",
      hunks: [{ index: 0, ours: "ours", theirs: "theirs", resolved: true, resolution: "ours", manualContent: null }]
    };

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_conflict_files") return Promise.resolve([singleHunkFile]);
      if (cmd === "mark_conflict_resolved") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    render(<ConflictResolver open={true} onClose={() => {}} onResolved={() => {}} forceFresh={true} />);

    await waitFor(() => {
      expect(screen.getByText("0/1 파일 해결됨")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Mark as Resolved → git add" }));

    await waitFor(() => {
      expect(screen.getByText("1/1 파일 해결됨")).toBeTruthy();
    });
  });

  it("fires onResolved in the same render cycle progress reaches N/N", async () => {
    const singleHunkFile = {
      path: "one.md",
      hunks: [{ index: 0, ours: "ours", theirs: "theirs", resolved: true, resolution: "ours", manualContent: null }]
    };
    const onResolved = vi.fn();

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "get_conflict_files") return Promise.resolve([singleHunkFile]);
      if (cmd === "mark_conflict_resolved") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    render(<ConflictResolver open={true} onClose={() => {}} onResolved={onResolved} forceFresh={true} />);

    await waitFor(() => {
      expect(screen.getByText("0/1 파일 해결됨")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Mark as Resolved → git add" }));

    await waitFor(() => {
      expect(screen.getByText("1/1 파일 해결됨")).toBeTruthy();
      expect(onResolved).toHaveBeenCalled();
    });
  });
});
