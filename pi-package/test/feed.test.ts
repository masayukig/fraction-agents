import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeFeed, parseFeed } from "../lib/feed.ts";

const BASE = "https://news.example/feed.xml";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example News</title>
    <link>https://news.example/</link>
    <item>
      <title>First &amp; foremost</title>
      <link>https://news.example/articles/1?utm_source=rss</link>
      <description><![CDATA[<p>The <b>first</b> story &amp; more.</p>]]></description>
      <pubDate>Sat, 10 Oct 2026 21:30:00 GMT</pubDate>
      <guid isPermaLink="false">tag:news.example,2026:1</guid>
    </item>
    <item>
      <title>Second</title>
      <link>/articles/2</link>
      <description>Plain &lt;i&gt;escaped&lt;/i&gt; HTML</description>
      <dc:date>2026-10-11T06:00:00+09:00</dc:date>
    </item>
    <item>
      <title>Only a guid</title>
      <guid>https://news.example/articles/3</guid>
      <content:encoded><![CDATA[<div>Body text</div>]]></content:encoded>
    </item>
    <item>
      <title>No link at all</title>
      <guid isPermaLink="false">opaque-id</guid>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Blog</title>
  <entry>
    <title type="html">A &lt;em&gt;bold&lt;/em&gt; entry</title>
    <link rel="alternate" type="text/html" href="https://blog.example/posts/a"/>
    <link rel="replies" href="https://blog.example/posts/a#comments"/>
    <id>urn:uuid:1</id>
    <published>2026-10-10T12:00:00Z</published>
    <updated>2026-10-10T13:00:00Z</updated>
    <summary>Short summary</summary>
  </entry>
  <entry>
    <title>Relative and updated only</title>
    <link href="posts/b"/>
    <id>urn:uuid:2</id>
    <updated>2026-10-09T00:00:00Z</updated>
    <content type="html">&lt;p&gt;Content as HTML&lt;/p&gt;</content>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example/"><title>RDF</title></channel>
  <item rdf:about="https://rdf.example/1">
    <title>RDF item</title>
    <link>https://rdf.example/1</link>
    <description>RDF description</description>
    <dc:date>2026-10-10T09:00:00+09:00</dc:date>
  </item>
</rdf:RDF>`;

describe("parseFeed", () => {
  it("reads RSS 2.0 items: title, link, summary as text, publication time", () => {
    const feed = parseFeed(RSS, BASE);
    assert.equal(feed.format, "rss");
    assert.equal(feed.title, "Example News");
    assert.equal(feed.entries.length, 4);
    const [first, second, third, fourth] = feed.entries;
    assert.deepEqual(first, {
      url: "https://news.example/articles/1?utm_source=rss",
      title: "First & foremost",
      summary: "The first story & more.",
      publishedAt: new Date("2026-10-10T21:30:00Z"),
    });
    assert.equal(second?.url, "https://news.example/articles/2", "relative links resolve against the feed");
    assert.equal(second?.summary, "Plain escaped HTML");
    assert.deepEqual(second?.publishedAt, new Date("2026-10-10T21:00:00Z"));
    assert.equal(third?.url, "https://news.example/articles/3", "a guid that is a URL stands in for the link");
    assert.equal(third?.summary, "Body text");
    assert.equal(third?.publishedAt, undefined);
    assert.equal(fourth?.url, undefined, "an opaque guid is not a link");
  });

  it("reads Atom entries: the alternate link, html titles, published or else updated", () => {
    const feed = parseFeed(ATOM, "https://blog.example/feed.atom");
    assert.equal(feed.format, "atom");
    assert.equal(feed.title, "Example Blog");
    const [a, b] = feed.entries;
    assert.deepEqual(a, {
      url: "https://blog.example/posts/a",
      title: "A bold entry",
      summary: "Short summary",
      publishedAt: new Date("2026-10-10T12:00:00Z"),
    });
    assert.equal(b?.url, "https://blog.example/posts/b");
    assert.equal(b?.summary, "Content as HTML");
    assert.deepEqual(b?.publishedAt, new Date("2026-10-09T00:00:00Z"));
  });

  it("reads RSS 1.0 (RDF), whose items sit beside the channel", () => {
    const feed = parseFeed(RDF, "https://rdf.example/index.rdf");
    assert.equal(feed.format, "rdf");
    assert.deepEqual(feed.entries, [
      { url: "https://rdf.example/1", title: "RDF item", summary: "RDF description", publishedAt: new Date("2026-10-10T00:00:00Z") },
    ]);
  });

  it("keeps titles and summaries short, and the number of entries bounded", () => {
    const items = Array.from(
      { length: 250 },
      (_, i) => `<item><title>${"t".repeat(400)}</title><link>https://news.example/${i}</link><description>${"s".repeat(2000)}</description></item>`,
    ).join("");
    const feed = parseFeed(`<rss><channel>${items}</channel></rss>`, BASE);
    assert.equal(feed.entries.length, 200);
    assert.ok([...feed.entries[0]!.title].length <= 300);
    assert.ok([...feed.entries[0]!.summary].length <= 500);
    assert.match(feed.entries[0]!.summary, /…$/);
  });

  it("does not expand entities declared in a DOCTYPE", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY boom "BOOM">]><rss><channel><item><title>&boom;</title><link>https://news.example/x</link></item></channel></rss>`;
    assert.equal(parseFeed(xml, BASE).entries[0]?.title, "&boom;");
  });

  it("refuses what is not a feed", () => {
    assert.throws(() => parseFeed("<html><body>Not a feed</body></html>", BASE), /not an RSS or Atom feed/);
    assert.throws(() => parseFeed("{\"json\": true}", BASE), /not an RSS or Atom feed/);
    assert.throws(() => parseFeed("<rss><channel><item><title>open", BASE), /XML/);
  });
});

describe("decodeFeed", () => {
  it("decodes by the Content-Type charset, then by the XML declaration, else UTF-8", () => {
    const sjis = Buffer.from([0x82, 0xa0]); // あ in Shift_JIS
    assert.equal(decodeFeed(sjis, "application/rss+xml; charset=Shift_JIS"), "あ");
    const declared = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="Shift_JIS"?>'), sjis]);
    assert.match(decodeFeed(declared, "application/xml"), /あ$/);
    assert.equal(decodeFeed(Buffer.from("﻿あ", "utf8"), undefined), "あ");
  });
});
