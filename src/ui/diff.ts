export interface DiffLine {
  type: "context" | "add" | "remove";
  text: string;
}

/**
 * Plain-text line diff (LCS-based) for in-app previews. No git shell-out.
 */
export function computeInMemoryDiff(before: string, after: string): DiffLine[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const m = beforeLines.length;
  const n = afterLines.length;

  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] =
        beforeLines[i] === afterLines[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (beforeLines[i] === afterLines[j]) {
      result.push({ type: "context", text: beforeLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ type: "remove", text: beforeLines[i] });
      i++;
    } else {
      result.push({ type: "add", text: afterLines[j] });
      j++;
    }
  }
  while (i < m) {
    result.push({ type: "remove", text: beforeLines[i] });
    i++;
  }
  while (j < n) {
    result.push({ type: "add", text: afterLines[j] });
    j++;
  }

  return result;
}
