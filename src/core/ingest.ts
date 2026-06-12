import { sendChatMessage, type ChatMessage } from "../api/llm";
import type { IngestRaw, IngestResult, LlmConfig } from "../api/types";

const DEFAULT_CONTEXT_LIMIT = 8000;
const MIN_EXTRACT_CHARS = 200;

export function buildIngestPrompt(
  raw: IngestRaw,
  contextLimit: number = DEFAULT_CONTEXT_LIMIT
): ChatMessage[] {
  const truncated =
    raw.text.length > contextLimit ? raw.text.slice(0, contextLimit) + "\n\n[... truncated]" : raw.text;

  const system: ChatMessage = {
    role: "system",
    content: `You are a knowledge extraction assistant. Convert the provided source text into a well-structured markdown note.

Output EXACTLY this format — no additional commentary:

---
tags: [tag1, tag2, tag3]
source: <source_ref>
---

# <Title>

## Summary
<2-4 sentence summary of the main idea>

## <Section 1 Name>
<key content from this section>

## <Section 2 Name>
<key content from this section>

(2-5 sections total based on content)

Rules:
- Title: concise, descriptive
- Tags: 3-6 lowercase keywords from the content
- Sections: named for the actual topics covered, not generic labels
- Write in clear, dense prose — no filler`,
  };

  const user: ChatMessage = {
    role: "user",
    content: `Source: ${raw.sourceRef}\n\n${truncated}`,
  };

  return [system, user];
}

function ensureProvenance(result: IngestResult, raw: IngestRaw): IngestResult {
  let { markdown } = result;
  const today = raw.ingestDate ?? new Date().toISOString().split("T")[0];

  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    let fm = fmMatch[1];
    if (!fm.includes("source:")) {
      const sourceValue =
        raw.sourceType === "pdf"
          ? `source_file: ${raw.sourceRef}`
          : `source: ${raw.sourceRef}`;
      fm = fm + `\n${sourceValue}`;
    }
    if (!fm.includes("ingest_date:")) {
      fm = fm + `\ningest_date: ${today}`;
    }
    if (raw.sourceType && !fm.includes("source_type:")) {
      fm = fm + `\nsource_type: ${raw.sourceType}`;
    }
    markdown = markdown.replace(fmMatch[0], `---\n${fm}\n---`);
  }

  return { ...result, markdown };
}

function parseIngestResponse(raw: string, sourceRef: string): IngestResult {
  const tagsMatch = raw.match(/^tags:\s*\[([^\]]+)\]/m);
  const tags = tagsMatch
    ? tagsMatch[1]
        .split(",")
        .map((t) => t.trim().replace(/['"]/g, ""))
        .filter(Boolean)
    : [];

  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : sourceRef;
  const markdown = raw.trim();

  return { title, markdown, tags };
}

export async function ingestToNote(
  raw: IngestRaw,
  llmConfig: LlmConfig,
  contextLimit?: number
): Promise<IngestResult> {
  const limit = contextLimit ?? DEFAULT_CONTEXT_LIMIT;

  if (raw.text.trim().length < MIN_EXTRACT_CHARS) {
    throw new Error("Extraction too thin — page may require a browser");
  }

  const messages = buildIngestPrompt(raw, limit);

  let response: string;
  try {
    response = await sendChatMessage(llmConfig, messages);
  } catch (err) {
    throw new Error(
      `${llmConfig.provider} did not respond: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!response || response.trim().length === 0) {
    throw new Error(`${llmConfig.provider} returned an empty response`);
  }

  return ensureProvenance(parseIngestResponse(response, raw.sourceRef), raw);
}
