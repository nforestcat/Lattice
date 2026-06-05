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
    expect(html).toContain("for n in range(3):");
    expect(html).toContain("print(n &lt; 2)");
  });

  it("renders inline code with a preview-specific class", () => {
    const html = renderMarkdownPreview("Use `for` for compact loops.");

    expect(html).toContain('<code class="inlineCode">for</code>');
  });
});
