import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { vaultApi } from "../src/api";
import type { EntryMutationResult, IngestDuplicateCheck, IngestRaw, IngestResult } from "../src/api/types";
import { useIngestQueue } from "../src/ui/hooks/useIngestQueue";

const RAW: IngestRaw = {
  title: "Source Article",
  text: "Long source text that has already been converted into a durable note draft.",
  sourceRef: "https://example.com/source",
  sourceType: "url",
  ingestDate: "2026-06-17",
};

const RESULT: IngestResult = {
  title: "Source Article",
  markdown: "---\ntags: [research]\n---\n\n# Source Article\n\nUseful detail.",
  tags: ["research"],
};

const DUPLICATE_CHECK: IngestDuplicateCheck = {
  exactMatch: null,
  similarNotes: [{ path: "Research/Existing.md", title: "Existing" }],
};

const EMPTY_MUTATION: EntryMutationResult = {
  vault: { rootPath: "Demo Vault", notes: [], tree: [] },
  selectedPath: null,
};

function IngestQueueHarness({ onIngested }: { readonly onIngested: (path: string) => void }) {
  const queue = useIngestQueue({
    onIngested,
    setVault: () => {},
  });

  return (
    <div>
      <button onClick={() => queue.enqueueIngest(RESULT, RAW, DUPLICATE_CHECK)}>
        enqueue
      </button>
      {queue.ingestItems.map((item) => (
        <div key={item.id}>
          <div>{item.title}</div>
          <button onClick={() => queue.updateIngestItem(item.id, { appendTargetPath: "Research/Existing.md" })}>
            append existing
          </button>
          <button onClick={() => void queue.applyIngestItem(item.id)}>apply</button>
        </div>
      ))}
    </div>
  );
}

describe("useIngestQueue", () => {
  it("appends a reviewed ingest draft to an existing note when append target is selected", async () => {
    // Given: a drafted ingest item has been reviewed with an append target.
    const onIngested = vi.fn();
    const readNoteSpy = vi.spyOn(vaultApi, "readNote").mockResolvedValue({
      path: "Research/Existing.md",
      content: "# Existing\n\nOriginal content.",
      revision: "rev-existing",
    });
    const saveNoteSpy = vi.spyOn(vaultApi, "saveNote").mockResolvedValue({
      saved: true,
      revision: "rev-next",
      conflict: false,
      snapshotId: null,
      gitCommit: null,
    });
    const createNoteSpy = vi.spyOn(vaultApi, "createNote").mockResolvedValue(EMPTY_MUTATION);

    render(<IngestQueueHarness onIngested={onIngested} />);
    fireEvent.click(screen.getByRole("button", { name: "enqueue" }));
    await screen.findByText("Source Article");
    fireEvent.click(screen.getByRole("button", { name: "append existing" }));

    // When: the reviewed queue item is applied.
    fireEvent.click(screen.getByRole("button", { name: "apply" }));

    // Then: the existing note is updated and no new ingest note is created.
    await waitFor(() => {
      expect(readNoteSpy).toHaveBeenCalledWith("Research/Existing.md");
      expect(saveNoteSpy).toHaveBeenCalledWith(
        "Research/Existing.md",
        expect.stringContaining("### Ingested Source (Source Article)"),
        "rev-existing"
      );
      expect(createNoteSpy).not.toHaveBeenCalled();
      expect(onIngested).toHaveBeenCalledWith("Research/Existing.md");
    });

    readNoteSpy.mockRestore();
    saveNoteSpy.mockRestore();
    createNoteSpy.mockRestore();
  });
});
