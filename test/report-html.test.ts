import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderReportHtml, renderReportList } from "../src/report-html.ts";
import type { ReportRecord } from "../src/reports.ts";

const RECORD: ReportRecord = {
  id: "0b6c2a5e-0000-4000-8000-000000000001",
  owner: "system:serviceaccount:fraction-agents:claude",
  contextId: "0b6c2a5e-0000-4000-8000-000000000002",
  title: "Rust の async <b>2026</b>",
  createdAt: Date.parse("2026-10-16T01:02:03Z"),
  partial: false,
};

function page(markdown: string, record: Partial<ReportRecord> = {}): string {
  return renderReportHtml({ ...RECORD, ...record }, markdown, { web: false });
}

/** The document's body, where the report's own content goes. */
function body(html: string): string {
  return html.slice(html.indexOf("<body"));
}

describe("report HTML", () => {
  it("is one document with its CSS and a policy that runs no script and loads nothing", () => {
    const html = page("# Title\n\nText.");
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<style>/);
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
    assert.ok(csp, "the policy is in the document");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.doesNotMatch(csp, /script-src/);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<link/i);
  });

  it("shows the title, the time, the caller and the note of a partial report as text", () => {
    const html = page("Text.", { partial: true });
    assert.match(html, /<title>Rust の async &lt;b&gt;2026&lt;\/b&gt;<\/title>/);
    assert.match(body(html), /Rust の async &lt;b&gt;2026&lt;\/b&gt;/);
    assert.doesNotMatch(body(html), /<b>2026/);
    assert.match(body(html), /claude/);
    assert.doesNotMatch(body(html), /serviceaccount/);
    assert.match(body(html), /2026-10-16/);
    assert.match(body(html), /時間の上限/);
    assert.doesNotMatch(body(page("Text.")), /時間の上限/);
  });

  it("shows raw HTML in the Markdown as text", () => {
    const html = body(page('Before <script>alert(1)</script> after.\n\n<img src="x" onerror="alert(2)">\n\n<div onclick="x()">d</div>'));
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<img/i);
    assert.doesNotMatch(html, /<div onclick/i);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it("does not load images, and links to them instead", () => {
    const html = body(page("![a chart](https://tracker.example/pixel.png)\n\n![local](/etc/passwd)"));
    assert.doesNotMatch(html, /<img/i);
    assert.match(html, /<a href="https:\/\/tracker\.example\/pixel\.png" rel="noopener noreferrer">[^<]*a chart/);
    assert.doesNotMatch(html, /href="\/etc\/passwd"/);
  });

  it("keeps http, https and in-page links only, and opens outside ones without a referrer", () => {
    const html = body(
      page(
        [
          "[web](https://example.com/a?b=1)",
          "[plain](http://example.com/)",
          "[script](javascript:alert(1))",
          "[data](data:text/html;base64,PHNjcmlwdD4=)",
          "[mail](mailto:a@example.com)",
          "[file](file:///etc/passwd)",
          "[relative](/reports)",
          "[protocol-relative](//evil.example/)",
          "[anchor](#section-1)",
          "bare https://bare.example/x",
        ].join("\n\n"),
      ),
    );
    assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1" rel="noopener noreferrer">web<\/a>/);
    assert.match(html, /<a href="http:\/\/example\.com\/" rel="noopener noreferrer">plain<\/a>/);
    assert.match(html, /<a href="#section-1">anchor<\/a>/);
    assert.match(html, /<a href="https:\/\/bare\.example\/x" rel="noopener noreferrer">/);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
    assert.deepEqual(hrefs, ["https://example.com/a?b=1", "http://example.com/", "#section-1", "https://bare.example/x"]);
  });

  it("makes a table of contents from the headings", () => {
    const html = body(page("# Survey\n\n## Runtimes\n\nText.\n\n### Tokio\n\n## Sources"));
    assert.match(html, /<nav[^>]*>[\s\S]*<a href="#section-2">Runtimes<\/a>[\s\S]*<a href="#section-3">Tokio<\/a>[\s\S]*<\/nav>/);
    assert.match(html, /<h2 id="section-2">Runtimes<\/h2>/);
  });

  it("renders tables", () => {
    const html = body(page("| a | b |\n|---|--:|\n| 1 | 2 |"));
    assert.match(html, /<table>/);
    assert.match(html, /<td style="text-align:right">2<\/td>/);
  });

  it("highlights code on the host's side", () => {
    const html = body(page("```ts\nconst x: number = 1;\n```"));
    assert.match(html, /<pre><code class="hljs language-ts">/);
    assert.match(html, /<span class="hljs-keyword">const<\/span>/);
  });

  it("leaves a Mermaid diagram as its text", () => {
    const html = body(page("```mermaid\ngraph TD; A-->B<script>x</script>\n```"));
    assert.match(html, /<pre class="mermaid">graph TD; A--&gt;B&lt;script&gt;x&lt;\/script&gt;\n<\/pre>/);
    assert.doesNotMatch(html, /<script/i);
  });

  it("loads the diagram script from its own origin on the page for people", () => {
    const html = renderReportHtml(RECORD, "```mermaid\ngraph TD; A-->B\n```", { web: true });
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
    assert.match(csp!, /script-src 'self'/);
    assert.match(html, /<script src="\.\.\/assets\/mermaid\.min\.js"><\/script>/);
    assert.match(html, /<script src="\.\.\/assets\/report\.js"><\/script>/);
    assert.equal((html.match(/<script/g) ?? []).length, 2, "no inline script");
  });
});

describe("report list page", () => {
  it("lists the reports with their time, title as text, caller and whether partial", () => {
    const html = renderReportList([RECORD, { ...RECORD, id: "0b6c2a5e-0000-4000-8000-000000000003", partial: true, title: "Second" }]);
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<a href="reports\/0b6c2a5e-0000-4000-8000-000000000001">Rust の async &lt;b&gt;2026&lt;\/b&gt;<\/a>/);
    assert.match(html, /claude/);
    assert.match(html, /途中まで/);
    assert.doesNotMatch(html, /<script/i);
  });
});
