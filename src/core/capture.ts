export type InboxCaptureInput = {
  content: string;
  relatedTitle?: string | null;
  capturedAt?: Date;
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

function formatCaptureTimestamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}
