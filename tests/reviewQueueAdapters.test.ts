import { describe, expect, it } from "vitest";
import type { IngestQueueItem } from "../src/api/types";
import { adaptIngestCapture } from "../src/ui/hooks/reviewQueueAdapters";

describe("adaptIngestCapture", () => {
  it("preserves ingest review metadata for queue review", () => {
    // Given: an ingest draft carries provenance, duplicate candidates, and an append target.
    const item: IngestQueueItem = {
      id: "ingest-1",
      title: "Source Article",
      tags: ["research"],
      markdown: "# Source Article",
      raw: {
        text: "Original extracted text from the source.",
        sourceRef: "https://example.com/source",
        sourceType: "url",
        ingestDate: "2026-06-17",
      },
      targetFolder: "Ingested",
      appendTargetPath: "Research/Existing.md",
      duplicateExact: "Research/Duplicate.md",
      similarNotes: [{ path: "Research/Duplicate.md", title: "Duplicate" }],
      suggestedLinks: [{ path: "Research/Existing.md", title: "Existing" }],
      status: "drafted",
      createdAt: 1,
    };

    // When: the ingest item is adapted into the shared review queue shape.
    const result = adaptIngestCapture(item);

    // Then: reviewers can see the target, provenance, and review candidates.
    expect(result.path).toBe("Research/Existing.md에 append");
    expect(result.reason).toContain("중복: Research/Duplicate.md");
    expect(result.reason).toContain("추천 링크 1건");
    expect(result.provenance).toMatchObject({
      source: "https://example.com/source",
      originalExcerpt: "Original extracted text from the source.",
    });
    expect(result.sourceRef).toBe(item);
  });
});
