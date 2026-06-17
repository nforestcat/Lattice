import { invoke } from "@tauri-apps/api/core";
import type { IngestDuplicateCheck } from "../../../api/types";

export async function checkIngestDuplicate(sourceRef: string): Promise<IngestDuplicateCheck | null> {
  try {
    return await invoke<IngestDuplicateCheck>("check_ingest_duplicate", { sourceRef });
  } catch (error) {
    if (error instanceof Error) {
      console.warn("Duplicate check failed", error.message);
    } else {
      console.warn("Duplicate check failed", String(error));
    }
    return null;
  }
}
