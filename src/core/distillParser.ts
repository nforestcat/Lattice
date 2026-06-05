import type { ProposedEdit } from "../api/types";

export function parseProposedEdits(rawText: string): ProposedEdit[] {
  const edits: ProposedEdit[] = [];
  let startIndex = 0;

  while (true) {
    const tagMatch = /<propose_edit\s+([^>]+)>/i.exec(rawText.slice(startIndex));
    if (!tagMatch) {
      break;
    }

    const tagStart = startIndex + tagMatch.index;
    const tagEnd = tagStart + tagMatch[0].length;

    const closingTagIndex = rawText.indexOf("</propose_edit>", tagEnd);
    if (closingTagIndex === -1) {
      break;
    }

    const innerContent = rawText.slice(tagEnd, closingTagIndex);
    startIndex = closingTagIndex + "</propose_edit>".length;

    const attrsStr = tagMatch[1];
    const typeVal = getAttributeValue(attrsStr, "type");
    const path = getAttributeValue(attrsStr, "path") || "";
    const newPath = getAttributeValue(attrsStr, "new_path") || getAttributeValue(attrsStr, "newPath") || undefined;

    if (!typeVal || !path) {
      continue;
    }

    const type = typeVal.toLowerCase() as ProposedEdit["type"];
    if (type !== "create" && type !== "update" && type !== "merge" && type !== "delete") {
      continue;
    }

    const reason = getTagContent(innerContent, "reason");
    const content = getTagContent(innerContent, "content");
    const targetContent = getTagContent(innerContent, "target_content") || getTagContent(innerContent, "targetContent");
    const replacementContent = getTagContent(innerContent, "replacement_content") || getTagContent(innerContent, "replacementContent");

    const id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 11);

    edits.push({
      id,
      type,
      path,
      newPath,
      content,
      targetContent,
      replacementContent,
      reason,
      applied: false
    });
  }

  return edits;
}

function getAttributeValue(attrsStr: string, name: string): string | null {
  const regex = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i");
  const match = regex.exec(attrsStr);
  return match ? match[1] : null;
}

function getTagContent(innerContent: string, tagName: string): string | undefined {
  const openTag = `<${tagName}>`;
  const closeTag = `</${tagName}>`;

  const start = innerContent.indexOf(openTag);
  if (start === -1) {
    return undefined;
  }

  const contentStart = start + openTag.length;
  const end = innerContent.indexOf(closeTag, contentStart);
  if (end === -1) {
    return undefined;
  }

  let val = innerContent.slice(contentStart, end);

  if (val.startsWith("<![CDATA[")) {
    val = val.slice(9);
    if (val.endsWith("]]>")) {
      val = val.slice(0, -3);
    }
  }

  return val;
}
