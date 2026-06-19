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

type InboxCaptureSpan = {
  capture: InboxCaptureBlock;
  start: number;
  end: number;
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
  return parseInboxCaptureSpans(markdown).map((span) => span.capture);
}

function parseInboxCaptureSpans(markdown: string): InboxCaptureSpan[] {
  const lastIdx = markdown.lastIndexOf("\n## Processed");
  const unprocessed = lastIdx === -1 ? markdown : markdown.slice(0, lastIdx);
  const matches = Array.from(unprocessed.matchAll(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$/gm));
  const seenTitles = new Map<string, number>();
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? unprocessed.length;
    const block = unprocessed.slice(start, end).trim();
    const title = match[1];
    const count = (seenTitles.get(title) ?? 0) + 1;
    seenTitles.set(title, count);
    const relatedTitle = block.match(/^Related:\s*\[\[([^\]]+)]]\s*$/m)?.[1] ?? null;
    const body = block
      .replace(/^## .+$/m, "")
      .replace(/^Related:\s*\[\[[^\]]+]]\s*$/m, "")
      .replace(/^#inbox\s*$/m, "")
      .trim();
    return {
      capture: {
        id: count === 1 ? title : `${title}#${count}`,
        title,
        relatedTitle,
        body,
        markdown: `${block}\n`
      },
      start,
      end
    };
  });
}

export function moveInboxCaptureToProcessed(markdown: string, captureId: string): string {
  const span = parseInboxCaptureSpans(markdown).find((candidate) => candidate.capture.id === captureId);
  if (!span) {
    throw new Error(`Capture not found: ${captureId}`);
  }

  const withoutCapture = `${markdown.slice(0, span.start)}${markdown.slice(span.end)}`.replace(/\n{3,}/g, "\n\n").trimEnd();
  const processedMatch = /^## Processed\s*$/m.exec(withoutCapture);
  if (processedMatch) {
    const insertPos = processedMatch.index + processedMatch[0].length;
    return `${withoutCapture.slice(0, insertPos)}\n\n${span.capture.markdown}${withoutCapture.slice(insertPos)}`.trimEnd();
  }
  return `${withoutCapture}\n\n## Processed\n\n${span.capture.markdown}`;
}

function formatCaptureTimestamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}
