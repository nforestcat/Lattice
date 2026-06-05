import { Marked, Renderer } from "marked";
import hljs from "highlight.js";

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
