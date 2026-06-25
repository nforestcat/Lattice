export function normalizeRef(value: string): string {
  return value.replace(/\\/g, "/").replace(/\.md$/i, "").trim().toLowerCase();
}
