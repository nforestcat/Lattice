import { describe, expect, it } from "vitest";
import type { IngestQueueItem, StubDraftReview } from "../src/api/types";
import { adaptIngestCapture, adaptStubDraft } from "../src/ui/hooks/reviewQueueAdapters";

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
      createdAt: 1,
    };

    // When: the ingest item is adapted into the shared review queue shape.
    const result = adaptIngestCapture(item);

    // Then: reviewers can see the target, provenance, and review candidates.
    expect(result.status).toBe("drafted");
    expect(result.path).toBe("Research/Existing.md에 append");
    expect(result.reason).toContain("중복: Research/Duplicate.md");
    expect(result.reason).toContain("추천 링크 1건");
    expect(result.provenance).toMatchObject({
      source: "https://example.com/source",
      originalExcerpt: "Original extracted text from the source.",
    });
    expect(result.sourceRef).toBe(item);
  });

  it("normalizes newly discovered ingest items to drafted workflow status", () => {
    // Given: an ingest item has editable source data but no source-owned lifecycle status.
    const item: IngestQueueItem = {
      id: "ingest-2",
      title: "Fresh Capture",
      tags: [],
      markdown: "# Fresh Capture",
      raw: {
        text: "Fresh source text.",
        sourceRef: "clipboard",
        sourceType: "text",
        ingestDate: "2026-06-17",
      },
      targetFolder: "Ingested",
      appendTargetPath: null,
      duplicateExact: null,
      similarNotes: [],
      suggestedLinks: [],
      createdAt: 2,
    };

    // When: the item is adapted for the Review Workflow.
    const result = adaptIngestCapture(item);

    // Then: lifecycle ownership starts in the Review Workflow.
    expect(result.status).toBe("drafted");
  });
});

describe("adaptStubDraft", () => {
  it("does not treat generated stub content as Review Workflow approval", () => {
    // Given: a source draft finished generation.
    const review: StubDraftReview = {
      content: "# Missing Target",
      status: "done",
    };

    // When: the generated draft is adapted for review.
    const result = adaptStubDraft("Missing Target", review);

    // Then: approval still belongs to the Review Workflow.
    expect(result.status).toBe("drafted");
    expect(result.kind).toBe("ingest_draft");
    expect(result.sourceId).toBe("Missing Target");
  });
});
