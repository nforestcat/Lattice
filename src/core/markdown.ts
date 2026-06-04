import type { NoteLink, ParsedNote } from "./types";

const WIKI_LINK_PATTERN = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const TAG_PATTERN = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;

export function parseMarkdownNote(path: string, rawContent: string): ParsedNote {
  const parsed = splitFrontmatter(rawContent);
  const content = parsed.content.trimStart();
  const title = findTitle(content, path);
  const tags = Array.from(new Set(findTags(content)));
  const links = findWikiLinks(path, content);

  return {
    path,
    title,
    tags,
    frontmatter: parsed.frontmatter,
    modifiedAt: undefined,
    contentHash: hashContent(rawContent),
    content: rawContent,
    links
  };
}

export function addManagedLink(content: string, targetRef: string): string {
  const normalizedTarget = targetRef.trim();
  if (!normalizedTarget) {
    return content;
  }

  const lines = content.split(/\r?\n/);
  const sectionStart = findManagedLinksSection(lines);
  const linkLine = `- [[${normalizedTarget}]]`;

  if (sectionStart === -1) {
    const separator = content.endsWith("\n") ? "\n" : "\n\n";
    return `${content}${separator}## Links\n\n${linkLine}\n`;
  }

  const sectionEnd = findSectionEnd(lines, sectionStart + 1);
  const existing = lines.slice(sectionStart + 1, sectionEnd).some((line) => extractFirstWikiTarget(line) === normalizedTarget);
  if (existing) {
    return content;
  }

  const insertAt = sectionEnd;
  const nextLines = [...lines];
  while (insertAt > sectionStart + 1 && nextLines[insertAt - 1] === "") {
    nextLines.splice(insertAt - 1, 1);
  }
  const refreshedSectionEnd = findSectionEnd(nextLines, sectionStart + 1);
  nextLines.splice(refreshedSectionEnd, 0, linkLine);
  return ensureTrailingNewline(nextLines.join("\n"));
}

export function removeManagedLink(content: string, targetRef: string): string {
  const lines = content.split(/\r?\n/);
  const sectionStart = findManagedLinksSection(lines);
  if (sectionStart === -1) {
    return content;
  }

  const sectionEnd = findSectionEnd(lines, sectionStart + 1);
  const nextLines = lines.filter((line, index) => {
    if (index <= sectionStart || index >= sectionEnd) {
      return true;
    }
    return extractFirstWikiTarget(line) !== targetRef;
  });

  return ensureTrailingNewline(nextLines.join("\n").replace(/\n{3,}/g, "\n\n"));
}

function findTitle(content: string, path: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) {
    return heading[1].trim();
  }

  return path.split(/[\\/]/).pop()?.replace(/\.md$/i, "") ?? path;
}

function findTags(content: string): string[] {
  return Array.from(content.matchAll(TAG_PATTERN), (match) => match[2]);
}

function findWikiLinks(sourcePath: string, content: string): NoteLink[] {
  const lines = content.split(/\r?\n/);
  const sectionStart = findManagedLinksSection(lines);
  const sectionEnd = sectionStart === -1 ? -1 : findSectionEnd(lines, sectionStart + 1);
  const links: NoteLink[] = [];

  lines.forEach((line, index) => {
    for (const match of line.matchAll(WIKI_LINK_PATTERN)) {
      links.push({
        sourcePath,
        targetRef: match[1].trim(),
        resolvedPath: null,
        line: index + 1,
        isManaged: sectionStart !== -1 && index > sectionStart && index < sectionEnd
      });
    }
  });

  return links;
}

function findManagedLinksSection(lines: string[]): number {
  return lines.findIndex((line) => /^##\s+Links\s*$/i.test(line.trim()));
}

function findSectionEnd(lines: string[], start: number): number {
  const nextHeading = lines.findIndex((line, index) => index >= start && /^#{1,2}\s+/.test(line.trim()));
  return nextHeading === -1 ? lines.length : nextHeading;
}

function extractFirstWikiTarget(line: string): string | null {
  const match = line.match(WIKI_LINK_PATTERN);
  if (!match) {
    return null;
  }
  const first = match[0].match(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/);
  return first?.[1].trim() ?? null;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function hashContent(content: string): string {
  let hash = 5381;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 33) ^ content.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}

function splitFrontmatter(rawContent: string): { frontmatter: Record<string, string>; content: string } {
  if (!rawContent.startsWith("---\n")) {
    return { frontmatter: {}, content: rawContent };
  }

  const end = rawContent.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, content: rawContent };
  }

  const yaml = rawContent.slice(4, end);
  const content = rawContent.slice(end + 4).replace(/^\r?\n/, "");
  const frontmatter = Object.fromEntries(
    yaml
      .split(/\r?\n/)
      .map((line) => line.split(":"))
      .filter((parts) => parts.length >= 2 && parts[0].trim())
      .map(([key, ...value]) => [key.trim(), value.join(":").trim().replace(/^["']|["']$/g, "")])
  );

  return { frontmatter, content };
}
