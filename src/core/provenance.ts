import type { AiProvenance } from "../api/types";

type FrontmatterEntry = {
  id: string;
  run: string | null;
  model: string;
  at: string;
  confidence?: number;
  source: string;
};

function parseFrontmatter(content: string): { yaml: string; body: string } | null {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;
  return {
    yaml: content.slice(4, end),
    body: content.slice(end + 4),
  };
}

function serializeFrontmatter(yaml: string, body: string): string {
  return `---\n${yaml}\n---${body}`;
}

/**
 * Adds a compact provenance stamp to note frontmatter under ai_edits:
 * Idempotent: keyed by editId, duplicate entries are never written.
 * Does not modify user prose or any other frontmatter keys.
 */
export function stampAiProvenance(content: string, prov: AiProvenance, editId: string): string {
  const parsed = parseFrontmatter(content);

  const entry: FrontmatterEntry = {
    id: editId,
    run: prov.promptRunId ?? null,
    model: prov.model ?? "unknown",
    at: prov.appliedAt ?? new Date().toISOString(),
    source: prov.source,
  };
  if (prov.confidence !== undefined) {
    entry.confidence = prov.confidence;
  }

  const entryLine = `  - ${JSON.stringify(entry)}`;

  if (!parsed) {
    const newFrontmatter = `ai_edits:\n${entryLine}`;
    return serializeFrontmatter(newFrontmatter, "\n" + content);
  }

  const { yaml, body } = parsed;

  const aiEditsMatch = yaml.match(/^(ai_edits:\n)((?:  - .*\n?)*)/m);

  if (!aiEditsMatch) {
    const newYaml = yaml.trimEnd() + `\nai_edits:\n${entryLine}`;
    return serializeFrontmatter(newYaml, body);
  }

  const existingBlock = aiEditsMatch[0];
  if (existingBlock.includes(`"id":"${editId}"`)) {
    return content;
  }

  const newBlock = existingBlock.trimEnd() + `\n${entryLine}`;
  const newYaml = yaml.replace(aiEditsMatch[0], newBlock + "\n");
  return serializeFrontmatter(newYaml, body);
}
