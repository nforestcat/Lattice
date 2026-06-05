import { Marked, Renderer } from "marked";

const markedPreview = new Marked();
const renderer = new Renderer();

renderer.code = ({ text, lang }) => {
  const language = normalizeLanguageLabel(lang);
  const badge = language ? `<span class="codeLanguage">${escapeHtml(language)}</span>` : "";
  return [
    '<figure class="codeBlock">',
    `<figcaption>${badge}</figcaption>`,
    `<pre><code>${escapeHtml(text)}</code></pre>`,
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
