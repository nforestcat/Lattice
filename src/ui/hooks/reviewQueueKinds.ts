import type { ReviewItemKind } from "../../api/types";

export const PERSISTABLE_KINDS: readonly ReviewItemKind[] = [
  "inbox_capture",
  "proposed_edit",
  "backlink_suggestion",
  "ingest_capture",
] as const;
