export function formatYamlTags(tags: string[]): string {
  return `[${tags.join(", ")}]`;
}

export function applyTagsToMarkdown(markdown: string, tags: string[]): string {
  const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---/;
  const match = markdown.match(frontmatterPattern);
  const tagLine = `tags: ${formatYamlTags(tags)}`;

  if (!match) {
    return `---\ntags: ${formatYamlTags(tags)}\n---\n\n${markdown}`;
  }

  const body = match[1] ?? "";
  const nextBody = /^tags:\s*.*$/m.test(body)
    ? body.replace(/^tags:\s*.*$/m, tagLine)
    : `${tagLine}\n${body}`;

  return markdown.replace(frontmatterPattern, `---\n${nextBody}\n---`);
}
