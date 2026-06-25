import { describe, expect, it } from "vitest";
import type { ReviewCapabilityInput } from "../src/ui/reviewWorkflow/stateMachine";
import {
  getReviewCapabilities,
  normalizeReviewPath,
  transitionReviewStatus,
} from "../src/ui/reviewWorkflow/stateMachine";

describe("review workflow state machine", () => {
  it.each([
    ["drafted", "approve", "approved"],
    ["drafted", "reject", "rejected"],
    ["drafted", "apply", null],
    ["drafted", "commit", null],
    ["approved", "approve", null],
    ["approved", "reject", "rejected"],
    ["approved", "apply", "applied"],
    ["approved", "commit", null],
    ["applied", "approve", null],
    ["applied", "reject", null],
    ["applied", "apply", null],
    ["applied", "commit", "committed"],
    ["rejected", "approve", null],
    ["rejected", "reject", null],
    ["rejected", "apply", null],
    ["rejected", "commit", null],
    ["committed", "approve", null],
    ["committed", "reject", null],
    ["committed", "apply", null],
    ["committed", "commit", null],
  ] as const)(
    "resolves %s with %s to %s",
    (status, operation, expectedStatus) => {
      // Given: an item is at one canonical lifecycle status.

      // When: one canonical operation is requested.
      const result = transitionReviewStatus(status, operation);

      // Then: only declared edges succeed and every other pair is typed invalid.
      expect(result).toEqual(
        expectedStatus === null
          ? { ok: false, code: "invalid_transition", operation, status }
          : { ok: true, status: expectedStatus }
      );
    }
  );

  it.each([
    ["Folder\\Nested\\Note.md", "Folder/Nested/Note.md"],
    ["./Folder\\MixedCase.md", "Folder/MixedCase.md"],
    ["././Already/Forward.md", "Already/Forward.md"],
    ["../Parent\\Note.md", "../Parent/Note.md"],
    ["", ""],
  ] as const)("normalizes review path %j to %j", (input, expected) => {
    // Given: a path may contain separators or leading current-directory segments.

    // When: the path enters the review workflow boundary.
    const result = normalizeReviewPath(input);

    // Then: separators and leading current-directory segments are canonicalized.
    expect(result).toBe(expected);
  });

  it.each([
    ["inbox_capture", undefined],
    ["ingest_capture", undefined],
    ["ingest_draft", undefined],
    ["proposed_edit", undefined],
    ["backlink_suggestion", undefined],
  ] as const)(
    "exposes the direct adapter lifecycle for %s",
    (kind, suggestionKind) => {
      // Given: a direct mutation item has an implemented apply adapter.
      const drafted = {
        kind,
        status: "drafted",
        suggestionKind,
      } satisfies ReviewCapabilityInput;
      const approved = {
        kind,
        status: "approved",
        suggestionKind,
      } satisfies ReviewCapabilityInput;
      const applied = {
        kind,
        status: "applied",
        suggestionKind,
      } satisfies ReviewCapabilityInput;

      // When: capabilities are derived at each active lifecycle status.
      const result = [
        getReviewCapabilities(drafted),
        getReviewCapabilities(approved),
        getReviewCapabilities(applied),
      ];

      // Then: review, apply, and commit are enabled only at their legal boundary.
      expect(result).toEqual([
        { approve: true, reject: true, apply: false, commit: false },
        { approve: false, reject: true, apply: true, commit: false },
        { approve: false, reject: false, apply: false, commit: true },
      ]);
    }
  );

  it.each([
    ["missing_summary", "summary"],
    ["orphan_note", "link_candidates"],
    ["stale_note", "review_prompt"],
    ["weak_backlinks", "backlinks_in"],
  ] as const)(
    "requires generated content before enabling %s/%s review",
    (kind, suggestionKind) => {
      // Given: a maintenance adapter exists but generated content may be absent.

      // When: drafted capabilities are derived before and after generation.
      const beforeGeneration = getReviewCapabilities({
        kind,
        status: "drafted",
        suggestionKind,
        hasGeneratedSuggestion: false,
      });
      const afterGeneration = getReviewCapabilities({
        kind,
        status: "drafted",
        suggestionKind,
        hasGeneratedSuggestion: true,
      });

      // Then: rejection is always available and approval requires generated content.
      expect(beforeGeneration).toEqual({
        approve: false,
        reject: true,
        apply: false,
        commit: false,
      });
      expect(afterGeneration).toEqual({
        approve: true,
        reject: true,
        apply: false,
        commit: false,
      });
    }
  );

  it.each([
    ["dead_link", undefined],
    ["duplicate_warning", "merge_or_delete"],
    ["too_broad", "split"],
  ] as const)(
    "keeps advisory capability row %s/%s reject-only",
    (kind, suggestionKind) => {
      // Given: an advisory item has no implemented apply adapter.

      // When: capabilities are derived despite generated content being present.
      const result = getReviewCapabilities({
        kind,
        status: "drafted",
        suggestionKind,
        hasGeneratedSuggestion: true,
      });

      // Then: only rejection is exposed.
      expect(result).toEqual({
        approve: false,
        reject: true,
        apply: false,
        commit: false,
      });
    }
  );
});
