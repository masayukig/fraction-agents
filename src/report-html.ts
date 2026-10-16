import hljs from "highlight.js";
import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";

import type { ReportRecord } from "./reports.ts";

/**
 * Reports as HTML (ADR 0020, 0021). The host makes the HTML from the Markdown in one fixed template; the model
 * writes none. Raw HTML in the Markdown is shown as text, and the HTML made is then cleaned against an allowlist,
 * so that a mistake of the converter does not let anything through. Links are kept to http, https and the page's
 * own headings; images are not loaded but linked to. The document carries its CSS and a Content Security Policy,
 * so a copy saved and opened at hand looks and behaves the same.
 */

/** The policy of a document read on its own: no script, nothing loaded from anywhere. */
const STANDALONE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/**
 * The policy of the pages for people: the diagram script and nothing else from their own origin. Mermaid writes
 * styles into the diagrams, so inline styles are allowed.
 */
export const WEB_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; " +
  "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

const PARTIAL_LABEL = "途中まで（時間の上限に来たため、ここまでの結果です）";

export interface RenderOptions {
  /** For the pages for people: the diagrams are drawn by the script under `../assets/`. */
  web: boolean;
}

interface Heading {
  id: string;
  level: number;
  text: string;
}

/** The report as one HTML document. */
export function renderReportHtml(record: ReportRecord, markdown: string, options: RenderOptions): string {
  const headings: Heading[] = [];
  const body = clean(converter(headings).render(markdown));
  const toc = headings.filter((heading) => heading.level <= 3);
  const policy = options.web ? WEB_POLICY.replace("; frame-ancestors 'none'", "") : STANDALONE_POLICY;
  return [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    ...head(record.title, policy),
    "</head>",
    "<body>",
    "<header>",
    `<h1 class="report-title">${escapeHtml(record.title)}</h1>`,
    `<p class="meta">${escapeHtml(formatTime(record.createdAt))} · 依頼元 ${escapeHtml(callerName(record.owner))}</p>`,
    record.partial ? `<p class="partial">${PARTIAL_LABEL}</p>` : "",
    "</header>",
    toc.length > 0
      ? `<nav class="toc" aria-label="目次"><ul>${toc
          .map((heading) => `<li class="level-${heading.level}"><a href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`)
          .join("")}</ul></nav>`
      : "",
    `<main>${body}</main>`,
    ...(options.web ? ['<script src="../assets/mermaid.min.js"></script>', '<script src="../assets/report.js"></script>'] : []),
    "</body>",
    "</html>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The list of reports for people, newest first as given. Titles are shown as text. */
export function renderReportList(records: readonly ReportRecord[]): string {
  const rows = records.map(
    (record) =>
      "<tr>" +
      `<td>${escapeHtml(formatTime(record.createdAt))}</td>` +
      `<td><a href="reports/${record.id}">${escapeHtml(record.title)}</a>${record.partial ? ' <span class="partial-mark">途中まで</span>' : ""}</td>` +
      `<td>${escapeHtml(callerName(record.owner))}</td>` +
      "</tr>",
  );
  return [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    ...head("レポート", WEB_POLICY.replace("; frame-ancestors 'none'", "")),
    "</head>",
    "<body>",
    '<header><h1 class="report-title">レポート</h1></header>',
    "<main>",
    records.length === 0
      ? "<p>まだレポートはありません。</p>"
      : `<table class="reports"><thead><tr><th>作成</th><th>題</th><th>依頼元</th></tr></thead><tbody>${rows.join("")}</tbody></table>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}

/** The caller as people read it: the last part of the ServiceAccount's name (`claude`). */
export function callerName(owner: string): string {
  return owner.split(":").at(-1) ?? owner;
}

/** The time in the host's time zone (`TZ`). */
function formatTime(ms: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(ms));
}

function head(title: string, policy: string): string[] {
  return [
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
  ];
}

function converter(headings: Heading[]): InstanceType<typeof MarkdownIt> {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    highlight: (code, lang) => {
      if (lang === "mermaid") return `<pre class="mermaid">${escapeHtml(code)}</pre>`;
      const language = /^[\w+-]+$/.test(lang) && hljs.getLanguage(lang) ? lang : undefined;
      const value = language ? hljs.highlight(code, { language, ignoreIllegals: true }).value : escapeHtml(code);
      return `<pre><code class="hljs${language ? ` language-${language}` : ""}">${value}</code></pre>`;
    },
  });
  // Numbered IDs for the headings, and the list for the table of contents.
  md.core.ruler.push("heading_ids", (state) => {
    state.tokens.forEach((token, index) => {
      if (token.type !== "heading_open") return;
      const id = `section-${headings.length + 1}`;
      token.attrSet("id", id);
      const inline = state.tokens[index + 1];
      const text = (inline?.children ?? []).map((child) => (child.type === "text" || child.type === "code_inline" ? child.content : "")).join("");
      headings.push({ id, level: Number(token.tag.slice(1)), text });
    });
  });
  // An image is shown as a link to it: opening the page tells no server that it was read.
  md.renderer.rules.image = (tokens, index) => {
    const token = tokens[index]!;
    const src = String(token.attrGet("src") ?? "");
    const alt = token.content === "" ? "画像" : `画像: ${token.content}`;
    return isWebUrl(src) ? `<a href="${escapeHtml(src)}">${escapeHtml(alt)}</a>` : escapeHtml(alt);
  };
  return md;
}

const ALLOWED_TAGS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "span",
  "em",
  "strong",
  "s",
  "del",
  "a",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

function clean(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "rel"],
      h1: ["id"],
      h2: ["id"],
      h3: ["id"],
      h4: ["id"],
      h5: ["id"],
      h6: ["id"],
      ol: ["start"],
      th: ["style"],
      td: ["style"],
      code: ["class"],
      span: ["class"],
      pre: ["class"],
    },
    allowedClasses: { code: ["hljs", "language-*"], span: ["hljs-*"], pre: ["mermaid"] },
    allowedStyles: { th: { "text-align": [/^(left|right|center)$/] }, td: { "text-align": [/^(left|right|center)$/] } },
    allowedSchemes: ["http", "https"],
    allowedSchemesByTag: {},
    allowProtocolRelative: false,
    disallowedTagsMode: "escape",
    transformTags: {
      a: (tagName, attribs): sanitizeHtml.Tag => {
        const href = attribs.href ?? "";
        if (/^#section-\d+$/.test(href)) return { tagName, attribs: { href } };
        if (isWebUrl(href)) return { tagName, attribs: { href, rel: "noopener noreferrer" } };
        return { tagName, attribs: {} };
      },
    },
  });
}

function isWebUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(value);
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ENTITIES[char]!);
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #ffffff; --line: #d1d9e0; --code: #f6f8fa; --accent: #0969da; --warn: #9a6700; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --bg: #0d1117; --line: #3d444d; --code: #151b23; --accent: #4493f8; --warn: #d29922; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 52rem; padding: 1.5rem 1rem 4rem; color: var(--fg); background: var(--bg); font: 16px/1.7 system-ui, -apple-system, "Hiragino Sans", "Noto Sans CJK JP", sans-serif; overflow-wrap: anywhere; }
a { color: var(--accent); }
header { border-bottom: 1px solid var(--line); margin-bottom: 1.5rem; }
.report-title { font-size: 1.6rem; line-height: 1.3; margin: 0 0 .5rem; }
.meta { color: var(--muted); margin: 0 0 1rem; font-size: .9rem; }
.partial, .partial-mark { color: var(--warn); font-weight: 600; }
.partial-mark { font-size: .8rem; }
.toc { border: 1px solid var(--line); border-radius: 6px; padding: .5rem 1rem; margin-bottom: 2rem; font-size: .9rem; }
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc .level-3 { padding-left: 1rem; }
h1, h2, h3, h4 { line-height: 1.3; margin: 2rem 0 .75rem; }
h2 { border-bottom: 1px solid var(--line); padding-bottom: .25rem; }
blockquote { margin: 1rem 0; padding: 0 1rem; color: var(--muted); border-left: 4px solid var(--line); }
pre { background: var(--code); border-radius: 6px; padding: .75rem 1rem; overflow-x: auto; line-height: 1.45; font-size: .85rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
:not(pre) > code { background: var(--code); border-radius: 4px; padding: .1rem .3rem; font-size: .85em; }
pre.mermaid { background: transparent; text-align: center; }
table { border-collapse: collapse; display: block; overflow-x: auto; margin: 1rem 0; }
th, td { border: 1px solid var(--line); padding: .35rem .75rem; vertical-align: top; }
table.reports { display: table; width: 100%; }
.hljs-comment, .hljs-quote { color: var(--muted); font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-type { color: #cf222e; }
.hljs-string, .hljs-attr, .hljs-template-tag { color: #0a3069; }
.hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable { color: #0550ae; }
.hljs-title, .hljs-section, .hljs-name { color: #8250df; }
@media (prefers-color-scheme: dark) {
  .hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-type { color: #ff7b72; }
  .hljs-string, .hljs-attr, .hljs-template-tag { color: #a5d6ff; }
  .hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable { color: #79c0ff; }
  .hljs-title, .hljs-section, .hljs-name { color: #d2a8ff; }
}
`
  .trim()
  .replace(/\n\s*/g, " ");
