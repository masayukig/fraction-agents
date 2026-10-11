// Feeds for the news agent (ADR 0017): RSS 2.0, RSS 1.0 (RDF) and Atom, read into entries of a link, a title, a
// summary as plain text and a publication time. The XML reader is small and strict about nesting; it never expands
// entities a DOCTYPE declares and never fetches anything. It imports nothing outside the package, so the collector
// runs it with plain node.
import { htmlToText } from "./gmail.ts";

/** The entries read from one fetch, and the lengths kept of each. */
export const ENTRIES_PER_FEED = 200;
export const TITLE_CHARS = 300;
export const SUMMARY_CHARS = 500;

export interface FeedEntry {
  /** Absolute, as the feed gives it (relative links resolved against the feed's URL). Not normalized. */
  url?: string;
  title: string;
  /** Plain text on one line, cut to {@link SUMMARY_CHARS}. Empty when the feed has none. */
  summary: string;
  publishedAt?: Date;
}

export interface Feed {
  format: "rss" | "rdf" | "atom";
  title?: string;
  entries: FeedEntry[];
}

// --- XML ---------------------------------------------------------------------------------------------------------

interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: (XmlElement | string)[];
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The five XML entities and character references. Anything else (`&nbsp;`, declared entities) stays as written. */
function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[name] ?? match;
  });
}

class XmlError extends Error {
  constructor(message: string) {
    super(`the feed is not well-formed XML: ${message}`);
  }
}

const NAME = /^[^\s/>=]+/;

function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#document", attributes: {}, children: [] };
  const stack: XmlElement[] = [root];
  let pos = 0;
  const top = () => stack[stack.length - 1]!;
  const skipPast = (end: string, what: string) => {
    const at = xml.indexOf(end, pos);
    if (at < 0) throw new XmlError(`unclosed ${what}`);
    pos = at + end.length;
  };
  while (pos < xml.length) {
    const lt = xml.indexOf("<", pos);
    if (lt < 0) {
      if (xml.slice(pos).trim() !== "" && stack.length > 1) top().children.push(decodeXmlText(xml.slice(pos)));
      break;
    }
    if (lt > pos && stack.length > 1) top().children.push(decodeXmlText(xml.slice(pos, lt)));
    pos = lt;
    if (xml.startsWith("<?", pos)) {
      skipPast("?>", "processing instruction");
    } else if (xml.startsWith("<!--", pos)) {
      skipPast("-->", "comment");
    } else if (xml.startsWith("<![CDATA[", pos)) {
      const end = xml.indexOf("]]>", pos);
      if (end < 0) throw new XmlError("unclosed CDATA section");
      if (stack.length > 1) top().children.push(xml.slice(pos + 9, end));
      pos = end + 3;
    } else if (xml.startsWith("<!", pos)) {
      // A DOCTYPE, with its internal subset if any. Its declarations are skipped, never applied.
      const bracket = xml.indexOf("[", pos);
      const close = xml.indexOf(">", pos);
      if (close < 0) throw new XmlError("unclosed declaration");
      if (bracket >= 0 && bracket < close) {
        pos = bracket;
        skipPast("]", "DOCTYPE");
      }
      skipPast(">", "declaration");
    } else if (xml.startsWith("</", pos)) {
      const end = xml.indexOf(">", pos);
      if (end < 0) throw new XmlError("unclosed end tag");
      const name = xml.slice(pos + 2, end).trim();
      if (stack.length === 1 || top().name !== name) throw new XmlError(`unexpected </${name}>`);
      stack.pop();
      pos = end + 1;
    } else {
      pos += 1;
      const name = NAME.exec(xml.slice(pos))?.[0];
      if (!name) throw new XmlError(`bad tag at ${lt}`);
      pos += name.length;
      const element: XmlElement = { name, attributes: {}, children: [] };
      for (;;) {
        while (/\s/.test(xml[pos] ?? "")) pos += 1;
        if (pos >= xml.length) throw new XmlError(`unclosed <${name}>`);
        if (xml.startsWith("/>", pos)) {
          pos += 2;
          top().children.push(element);
          break;
        }
        if (xml[pos] === ">") {
          pos += 1;
          top().children.push(element);
          stack.push(element);
          break;
        }
        const attribute = /^([^\s/>=]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(xml.slice(pos, pos + 10_000));
        if (!attribute) throw new XmlError(`bad attribute in <${name}>`);
        element.attributes[attribute[1]!] = decodeXmlText(attribute[3] ?? attribute[4] ?? "");
        pos += attribute[0].length;
      }
    }
  }
  if (stack.length > 1) throw new XmlError(`unclosed <${top().name}>`);
  const element = root.children.find((child): child is XmlElement => typeof child !== "string");
  if (!element) throw new XmlError("no root element");
  return element;
}

function localName(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

function elements(parent: XmlElement, name?: string): XmlElement[] {
  return parent.children.filter((child): child is XmlElement => typeof child !== "string" && (name === undefined || localName(child.name) === name));
}

function child(parent: XmlElement, name: string): XmlElement | undefined {
  return elements(parent, name)[0];
}

function textOf(element: XmlElement): string {
  return element.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
}

/** The text of the first child of the first of `names` that the parent has. */
function childText(parent: XmlElement, ...names: string[]): string | undefined {
  for (const name of names) {
    const found = child(parent, name);
    if (found) return textOf(found);
  }
  return undefined;
}

// --- Feeds -------------------------------------------------------------------------------------------------------

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cut(text: string, limit: number): string {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`;
}

function plain(text: string | undefined, limit: number): string {
  return cut(oneLine(text ?? ""), limit);
}

function fromHtml(html: string | undefined, limit: number): string {
  return cut(oneLine(htmlToText(html ?? "")), limit);
}

function time(text: string | undefined): Date | undefined {
  if (!text?.trim()) return undefined;
  const ms = Date.parse(text.trim());
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}

function absolute(link: string | undefined, base: string): string | undefined {
  const value = link?.trim();
  if (!value) return undefined;
  try {
    return new URL(value, base).href;
  } catch {
    return undefined;
  }
}

/** Text of an Atom text construct (`type` text, html or xhtml). */
function atomText(element: XmlElement | undefined, limit: number): string {
  if (!element) return "";
  const type = element.attributes.type ?? "text";
  if (type === "html") return fromHtml(textOf(element), limit);
  return plain(textOf(element), limit);
}

function rssEntry(item: XmlElement, base: string): FeedEntry {
  const link = elements(item, "link").find((l) => textOf(l).trim() !== "");
  const atomLink = elements(item, "link").find((l) => l.attributes.href && (l.attributes.rel ?? "alternate") === "alternate");
  const guid = child(item, "guid");
  const guidLink = guid && guid.attributes.isPermaLink !== "false" && /^https?:\/\//i.test(textOf(guid).trim()) ? textOf(guid) : undefined;
  const url = absolute(link ? textOf(link) : (atomLink?.attributes.href ?? guidLink), base);
  const publishedAt = time(childText(item, "pubDate", "date"));
  return {
    ...(url ? { url } : {}),
    title: plain(childText(item, "title"), TITLE_CHARS),
    // RSS carries HTML in its descriptions, escaped or in CDATA.
    summary: fromHtml(childText(item, "description", "encoded"), SUMMARY_CHARS),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

function atomEntry(entry: XmlElement, base: string): FeedEntry {
  const links = elements(entry, "link").filter((l) => l.attributes.href);
  const link = links.find((l) => (l.attributes.rel ?? "alternate") === "alternate");
  const url = absolute(link?.attributes.href, entry.attributes["xml:base"] ?? base);
  const publishedAt = time(childText(entry, "published", "updated"));
  return {
    ...(url ? { url } : {}),
    title: atomText(child(entry, "title"), TITLE_CHARS),
    summary: atomText(child(entry, "summary") ?? child(entry, "content"), SUMMARY_CHARS),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

const NOT_A_FEED = "the response is not an RSS or Atom feed";

/** Reads an RSS 2.0, RSS 1.0 or Atom feed. `baseUrl` is the feed's own URL, for relative links. */
export function parseFeed(xml: string, baseUrl: string): Feed {
  if (!xml.trimStart().replace(/^﻿/, "").startsWith("<")) throw new Error(NOT_A_FEED);
  const root = parseXml(xml.replace(/^﻿/, ""));
  const kind = localName(root.name);
  if (kind === "rss") {
    const channel = child(root, "channel");
    const items = channel ? elements(channel, "item") : [];
    const title = channel && child(channel, "title");
    return { format: "rss", ...(title ? { title: plain(textOf(title), TITLE_CHARS) } : {}), entries: items.slice(0, ENTRIES_PER_FEED).map((i) => rssEntry(i, baseUrl)) };
  }
  if (kind === "RDF") {
    const channel = child(root, "channel");
    const title = channel && child(channel, "title");
    const items = [...elements(root, "item"), ...(channel ? elements(channel, "item") : [])];
    return { format: "rdf", ...(title ? { title: plain(textOf(title), TITLE_CHARS) } : {}), entries: items.slice(0, ENTRIES_PER_FEED).map((i) => rssEntry(i, baseUrl)) };
  }
  if (kind === "feed") {
    const title = child(root, "title");
    const base = root.attributes["xml:base"] ? (absolute(root.attributes["xml:base"], baseUrl) ?? baseUrl) : baseUrl;
    return {
      format: "atom",
      ...(title ? { title: atomText(title, TITLE_CHARS) } : {}),
      entries: elements(root, "entry").slice(0, ENTRIES_PER_FEED).map((e) => atomEntry(e, base)),
    };
  }
  throw new Error(`${NOT_A_FEED} (its root element is <${root.name}>)`);
}

/** The feed's bytes as text: the charset of the Content-Type, else the XML declaration's encoding, else UTF-8. */
export function decodeFeed(bytes: Uint8Array, contentType: string | undefined): string {
  const fromHeader = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? "")?.[1];
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const fromDeclaration = /^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head.replace(/^﻿|^ï»¿/, ""))?.[1];
  for (const label of [fromHeader, fromDeclaration, "utf-8"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // An unknown charset: try the next.
    }
  }
  return new TextDecoder().decode(bytes);
}
