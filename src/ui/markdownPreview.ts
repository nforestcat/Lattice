import { Marked, Renderer } from "marked";
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

export function renderMarkdownPreview(markdown: string): string {
  return markedPreview.parse(markdown) as string;
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
