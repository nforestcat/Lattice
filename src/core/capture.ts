export type InboxCaptureInput = {
  content: string;
  relatedTitle?: string | null;
  capturedAt?: Date;
};

export type InboxCaptureBlock = {
  id: string;
  title: string;
  relatedTitle: string | null;
  body: string;
  markdown: string;
};

export function formatInboxCapture(input: InboxCaptureInput): string {
  const content = input.content.trim();
  if (!content) {
    throw new Error("Capture content is required");
  }

  const lines = [
    `## ${formatCaptureTimestamp(input.capturedAt ?? new Date())}`,
    ""
  ];

  if (input.relatedTitle) {
    lines.push(`Related: [[${input.relatedTitle}]]`, "");
  }

  lines.push("#inbox", "", content, "");
  return lines.join("\n");
}

export function inboxPathForDate(date: Date): string {
  return `Inbox/${date.toISOString().slice(0, 10)}.md`;
}

export function parseInboxCaptures(markdown: string): InboxCaptureBlock[] {
  const unprocessed = markdown.split(/\n## Processed\b/i)[0] ?? "";
  const matches = Array.from(unprocessed.matchAll(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$/gm));
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? unprocessed.length;
    const block = unprocessed.slice(start, end).trim();
    const title = match[1];
    const relatedTitle = block.match(/^Related:\s*\[\[([^\]]+)]]\s*$/m)?.[1] ?? null;
    const body = block
      .replace(/^## .+$/m, "")
      .replace(/^Related:\s*\[\[[^\]]+]]\s*$/m, "")
      .replace(/^#inbox\s*$/m, "")
      .trim();
    return {
      id: title,
      title,
      relatedTitle,
      body,
      markdown: `${block}\n`
    };
  });
}

export function moveInboxCaptureToProcessed(markdown: string, captureId: string): string {
  const captures = parseInboxCaptures(markdown);
  const capture = captures.find((candidate) => candidate.id === captureId);
  if (!capture) {
    throw new Error(`Capture not found: ${captureId}`);
  }

  const withoutCapture = markdown.replace(capture.markdown.trim(), "").replace(/\n{3,}/g, "\n\n").trimEnd();
  if (/^## Processed\s*$/m.test(withoutCapture)) {
    return `${withoutCapture}\n\n${capture.markdown}`;
  }
  return `${withoutCapture}\n\n## Processed\n\n${capture.markdown}`;
}

function formatCaptureTimestamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}
