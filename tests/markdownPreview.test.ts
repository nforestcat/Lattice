import { describe, expect, it } from "vitest";
import { renderMarkdownPreview } from "../src/ui/markdownPreview";

describe("renderMarkdownPreview", () => {
  it("renders fenced code blocks with language badges and escaped code", () => {
    const html = renderMarkdownPreview([
      "```python",
      "for n in range(3):",
      "    print(n < 2)",
      "```"
    ].join("\n"));

    expect(html).toContain('class="codeBlock"');
    expect(html).toContain('class="codeLanguage">Python</span>');
    expect(html).toContain('class="hljs"');
    // Ensure syntax highlighting is active
    expect(html).toContain('class="hljs-keyword">for</span>');
    expect(html).toContain("n &lt;");
    expect(html).toContain('<span class="hljs-number">2</span>');
  });

  it("renders inline code with a preview-specific class", () => {
    const html = renderMarkdownPreview("Use `for` for compact loops.");

    expect(html).toContain('<code class="inlineCode">for</code>');
  });

  it("adds source line metadata without breaking inline markdown", () => {
    const html = renderMarkdownPreview(["# Title", "", "Use **bold** and `code`.", "", "- [x] Ship `fix`"].join("\n"));

    expect(html).toContain('<h1 data-line="1">Title</h1>');
    expect(html).toContain('<p data-line="3">Use <strong>bold</strong> and <code class="inlineCode">code</code>.</p>');
    expect(html).toContain('<ul data-line="5">');
    expect(html).toContain('<input checked="" disabled="" type="checkbox">');
    expect(html).toContain('<code class="inlineCode">fix</code>');
  });
});
