import { Marked, Renderer, Lexer } from "marked";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import rust from "highlight.js/lib/languages/rust";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("sql", sql);

const markedPreview = new Marked();
const renderer = new Renderer();

renderer.code = ({ text, lang }) => {
  const language = normalizeLanguageLabel(lang);
  const badge = language ? `<span class="codeLanguage">${escapeHtml(language)}</span>` : "";
  
  let highlighted = escapeHtml(text);
  if (lang && hljs.getLanguage(lang)) {
    try {
      highlighted = hljs.highlight(text, { language: lang }).value;
    } catch (_) {
      // fallback
    }
  }

  return [
    '<figure class="codeBlock">',
    `<figcaption>${badge}</figcaption>`,
    `<pre><code class="hljs">${highlighted}</code></pre>`,
    "</figure>"
  ].join("");
};

renderer.codespan = ({ text }) => {
  return `<code class="inlineCode">${escapeHtml(text)}</code>`;
};

markedPreview.use({ renderer });

export function renderMarkdownPreview(markdownSrc: string): string {
  // Build a line-number queue by scanning top-level tokens in order.
  // marked's Lexer preserves document order, so we consume from the front
  // as each block renderer fires.
  const tokens = Lexer.lex(markdownSrc);

  // Only track line numbers for block types that have custom renderers below.
  const trackedTypes = new Set(["heading", "paragraph", "blockquote", "list"]);
  const lineQueue: number[] = [];
  let line = 1;
  for (const token of tokens) {
    if (trackedTypes.has(token.type)) {
      lineQueue.push(line);
    }
    line += ((token as any).raw as string ?? "").split("\n").length - 1;
  }

  let queueIndex = 0;
  const nextLine = () => lineQueue[queueIndex++] ?? 1;

  const lineRenderer = new Renderer();
  lineRenderer.code = renderer.code.bind(renderer);
  lineRenderer.codespan = renderer.codespan.bind(renderer);

  lineRenderer.heading = (args) => {
    const ln = nextLine();
    return `<h${args.depth} data-line="${ln}">${args.text}</h${args.depth}>\n`;
  };

  lineRenderer.paragraph = (args) => {
    const ln = nextLine();
    return `<p data-line="${ln}">${args.text}</p>\n`;
  };

  lineRenderer.blockquote = (args) => {
    const ln = nextLine();
    return `<blockquote data-line="${ln}">${args.text}</blockquote>\n`;
  };

  lineRenderer.list = (args) => {
    const ln = nextLine();
    const tag = args.ordered ? "ol" : "ul";
    const startAttr = args.ordered && args.start !== 1 ? ` start="${args.start}"` : "";
    const itemsHtml = args.items.map((item) => {
      const checkbox = item.task ? `<input type="checkbox" disabled${item.checked ? " checked" : ""}> ` : "";
      return `<li>${checkbox}${item.text}</li>`;
    }).join("\n");
    return `<${tag}${startAttr} data-line="${ln}">\n${itemsHtml}\n</${tag}>\n`;
  };

  const instance = new Marked();
  instance.use({ renderer: lineRenderer });
  return instance.parse(markdownSrc) as string;
}

function normalizeLanguageLabel(lang?: string): string {
  const raw = lang?.trim().split(/\s+/)[0] ?? "";
  if (!raw) {
    return "";
  }
  const aliases: Record<string, string> = {
    js: "JavaScript",
    jsx: "JSX",
    ts: "TypeScript",
    tsx: "TSX",
    py: "Python",
    python: "Python",
    rs: "Rust",
    rust: "Rust",
    sh: "Shell",
    bash: "Bash",
    zsh: "Zsh",
    powershell: "PowerShell",
    ps1: "PowerShell",
    sql: "SQL",
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    html: "HTML",
    css: "CSS"
  };
  const lower = raw.toLowerCase();
  return aliases[lower] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
