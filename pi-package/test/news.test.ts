import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  collectOnce,
  normalizeUrl,
  NewsStore,
  parseNewsConfig,
  parseSince,
  runCollector,
  type NewsConfig,
} from "../lib/news.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-10-11 (Sun) 08:00 in Tokyo.
const NOW = new Date("2026-10-10T23:00:00Z");

function storeDir(): string {
  return join(mkdtempSync(join(tmpdir(), "news-")), "news");
}

function rss(items: { title: string; link: string; summary?: string; pubDate?: string }[]): string {
  const body = items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>${item.link}</link>${item.summary ? `<description>${item.summary}</description>` : ""}${item.pubDate ? `<pubDate>${item.pubDate}</pubDate>` : ""}</item>`,
    )
    .join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${body}</channel></rss>`;
}

function atom(entries: { title: string; href: string; published?: string }[]): string {
  const body = entries
    .map((e) => `<entry><title>${e.title}</title><link href="${e.href}"/><id>${e.href}</id>${e.published ? `<published>${e.published}</published>` : ""}</entry>`)
    .join("");
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title>${body}</feed>`;
}

type Responder = (request: Request, attempt: number) => Response | Promise<Response>;

/** A fetch that never leaves the process: each URL answers from its responder. */
class FakeWeb {
  readonly requests: Request[] = [];
  readonly #routes = new Map<string, Responder>();
  readonly #attempts = new Map<string, number>();

  route(url: string, responder: Responder | string): void {
    this.#routes.set(url, typeof responder === "string" ? () => new Response(responder, { headers: { "content-type": "application/rss+xml" } }) : responder);
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    this.requests.push(request);
    const attempt = (this.#attempts.get(request.url) ?? 0) + 1;
    this.#attempts.set(request.url, attempt);
    const responder = this.#routes.get(request.url);
    if (!responder) throw new TypeError(`fetch failed: no route to ${request.url}`);
    return responder(request, attempt);
  };

  count(url: string): number {
    return this.requests.filter((r) => r.url === url).length;
  }
}

function config(sources: NewsConfig["sources"], dir = storeDir()): NewsConfig {
  return { timeZone: "Asia/Tokyo", intervalMinutes: 60, storeDir: dir, sources };
}

const FEED_A = { name: "Example A", kind: "feed" as const, url: "https://a.example/feed.xml" };
const FEED_B = { name: "Example B", kind: "feed" as const, url: "https://b.example/atom.xml" };

describe("news.json", () => {
  it("reads sources of kind feed, with defaults for the rest", () => {
    const parsed = parseNewsConfig({ sources: [{ name: "Example", kind: "feed", url: "https://news.example/rss" }] });
    assert.deepEqual(parsed, {
      timeZone: "UTC",
      intervalMinutes: 60,
      storeDir: "/data/news",
      sources: [{ name: "Example", kind: "feed", url: "https://news.example/rss" }],
    });
  });

  it("accepts the example in the repository", () => {
    const example = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents", "news-agent", "news.example.json");
    const parsed = parseNewsConfig(JSON.parse(readFileSync(example, "utf8")));
    assert.ok(parsed.sources.length > 0);
    for (const source of parsed.sources) assert.match(new URL(source.url).hostname, /\.example$/, "the example's sources are made up");
  });

  const bad: [string, unknown, RegExp][] = [
    ["not an object", [], /must be an object/],
    ["no sources", {}, /sources/],
    ["empty sources", { sources: [] }, /at least one/],
    ["unknown kind", { sources: [{ name: "X", kind: "html", url: "https://x.example/" }] }, /kind/],
    ["no name", { sources: [{ kind: "feed", url: "https://x.example/" }] }, /name/],
    ["a name of two lines", { sources: [{ name: "X\nY", kind: "feed", url: "https://x.example/" }] }, /name/],
    ["duplicate names", { sources: [FEED_A, { ...FEED_B, name: FEED_A.name }] }, /twice/],
    ["duplicate URLs", { sources: [FEED_A, { ...FEED_B, url: FEED_A.url }] }, /twice/],
    ["not http", { sources: [{ name: "X", kind: "feed", url: "file:///etc/passwd" }] }, /http/],
    ["unknown source field", { sources: [{ ...FEED_A, extra: 1 }] }, /unknown/],
    ["unknown field", { sources: [FEED_A], stateDir: "/x" }, /unknown/],
    ["bad time zone", { sources: [FEED_A], timeZone: "Nowhere/None" }, /timeZone/],
    ["interval too short", { sources: [FEED_A], intervalMinutes: 1 }, /intervalMinutes/],
    ["interval not a number", { sources: [FEED_A], intervalMinutes: "60" }, /intervalMinutes/],
    ["relative store", { sources: [FEED_A], storeDir: "news" }, /storeDir/],
  ];
  for (const [what, input, message] of bad) {
    it(`refuses ${what}`, () => {
      assert.throws(() => parseNewsConfig(input), message);
    });
  }
});

describe("normalizeUrl", () => {
  it("drops fragments, tracking parameters and default ports, and sorts the query", () => {
    assert.equal(
      normalizeUrl("HTTPS://News.Example:443/a/b?utm_source=rss&b=2&a=1&fbclid=x&utm_medium=feed#comments"),
      "https://news.example/a/b?a=1&b=2",
    );
    assert.equal(normalizeUrl("https://news.example/a?utm_campaign=x"), "https://news.example/a");
    assert.equal(normalizeUrl("http://news.example"), "http://news.example/");
  });

  it("resolves relative URLs and refuses what is not http", () => {
    assert.equal(normalizeUrl("../b", "https://news.example/x/y/feed"), "https://news.example/x/b");
    assert.equal(normalizeUrl("javascript:alert(1)"), undefined);
    assert.equal(normalizeUrl("mailto:someone@news.example"), undefined);
    assert.equal(normalizeUrl("not a url"), undefined);
    assert.equal(normalizeUrl(""), undefined);
  });

  it("keeps what tells pages apart: path case, trailing slash, other parameters", () => {
    assert.equal(normalizeUrl("https://news.example/A/"), "https://news.example/A/");
    assert.equal(normalizeUrl("https://news.example/item?id=42"), "https://news.example/item?id=42");
  });
});

describe("parseSince (the line 前回の受け取り)", () => {
  it("reads the time with its offset, with or without the zone in brackets and the label", () => {
    const expected = new Date("2026-10-10T22:00:00Z");
    assert.deepEqual(parseSince("2026-10-11T07:00:00+09:00"), expected);
    assert.deepEqual(parseSince("2026-10-11T07:00:00+09:00 (JST)"), expected);
    assert.deepEqual(parseSince("2026-10-11T07:00:00+09:00 (Asia/Tokyo)"), expected);
    assert.deepEqual(parseSince("前回の受け取り: 2026-10-11T07:00:00+09:00 (JST)"), expected);
    assert.deepEqual(parseSince("2026-10-10T22:00:00Z"), expected);
    assert.deepEqual(parseSince("2026-10-10T22:00:00.250Z"), new Date("2026-10-10T22:00:00.250Z"));
  });

  it("refuses a time without an offset or that is not a time", () => {
    assert.throws(() => parseSince("2026-10-11T07:00:00"), /offset/);
    assert.throws(() => parseSince("2026-10-11"), /offset/);
    assert.throws(() => parseSince("yesterday"), /ISO 8601/);
    assert.throws(() => parseSince("2026-13-40T07:00:00+09:00"), /ISO 8601/);
  });
});

describe("NewsStore", () => {
  it("keeps articles by normalized URL, once, with the time they were taken in", () => {
    const store = new NewsStore(storeDir());
    const first = store.addArticles(
      "Example A",
      [
        { url: "https://news.example/1?utm_source=rss", title: "One", summary: "s1", publishedAt: new Date("2026-10-10T20:00:00Z") },
        { url: "https://news.example/2", title: "Two", summary: "" },
        { url: "https://news.example/2#again", title: "Two again in the same feed", summary: "" },
      ],
      NOW,
    );
    assert.deepEqual(
      first.map((a) => a.url),
      ["https://news.example/1", "https://news.example/2"],
    );
    const again = store.addArticles("Example B", [{ url: "https://news.example/1", title: "One elsewhere", summary: "" }], new Date(NOW.getTime() + HOUR));
    assert.deepEqual(again, [], "the same article seen again is not new");
    const all = store.articlesIngestedAfter(new Date(0), NOW);
    assert.equal(all.length, 2);
    assert.deepEqual(all[0], {
      id: all[0]!.id,
      url: "https://news.example/1",
      title: "One",
      summary: "s1",
      source: "Example A",
      publishedAt: "2026-10-10T20:00:00.000Z",
      ingestedAt: NOW.toISOString(),
    });
    assert.match(all[0]!.id, /^[0-9a-f]{12}$/);
  });

  it("selects by the time an article was taken in, not by its publication time", () => {
    const store = new NewsStore(storeDir());
    const t1 = new Date("2026-10-10T20:00:00Z");
    const t2 = new Date("2026-10-10T22:30:00Z");
    store.addArticles("A", [{ url: "https://news.example/old", title: "Taken in before", summary: "" }], t1);
    // Published long ago, but taken in after the line's time: still new.
    store.addArticles("A", [{ url: "https://news.example/late", title: "Late", summary: "", publishedAt: new Date("2026-09-01T00:00:00Z") }], t2);
    // No publication time at all.
    store.addArticles("A", [{ url: "https://news.example/undated", title: "Undated", summary: "" }], t2);
    const since = parseSince("前回の受け取り: 2026-10-11T07:00:00+09:00 (JST)");
    const fresh = store.articlesIngestedAfter(since, NOW);
    assert.deepEqual(
      fresh.map((a) => a.title),
      ["Late", "Undated"],
    );
    assert.deepEqual(store.articlesIngestedAfter(t1, NOW).length, 2, "strictly after the time");
  });

  it("deletes articles 30 days after they were taken in, and takes them in again as new", () => {
    const dir = storeDir();
    const store = new NewsStore(dir);
    store.addArticles("A", [{ url: "https://news.example/old", title: "Old", summary: "" }], new Date(NOW.getTime() - 31 * DAY));
    store.addArticles("A", [{ url: "https://news.example/edge", title: "Edge", summary: "" }], new Date(NOW.getTime() - 30 * DAY + HOUR));
    store.addArticles("A", [{ url: "https://news.example/new", title: "New", summary: "" }], new Date(NOW.getTime() - HOUR));
    const removed = store.prune(NOW);
    assert.equal(removed, 1);
    assert.deepEqual(
      store.articlesIngestedAfter(new Date(0), NOW).map((a) => a.title),
      ["Edge", "New"],
    );
    const later = new Date(NOW.getTime() + 2 * HOUR);
    assert.equal(store.prune(later), 1, "the edge goes once it is 30 days old");
    const again = store.addArticles("A", [{ url: "https://news.example/old", title: "Old again", summary: "" }], later);
    assert.equal(again.length, 1);
    // A day's file is gone once nothing in it is left.
    assert.equal(readdirSync(join(dir, "articles")).length, 2);
  });

  it("returns nothing older than 30 days even before the collector prunes", () => {
    const store = new NewsStore(storeDir());
    store.addArticles("A", [{ url: "https://news.example/old", title: "Old", summary: "" }], new Date(NOW.getTime() - 31 * DAY));
    assert.deepEqual(store.articlesIngestedAfter(new Date(0), NOW), []);
  });

  it("survives a restart: written state reads back, half-written files are ignored and cleaned", () => {
    const dir = storeDir();
    const store = new NewsStore(dir);
    store.addArticles("A", [{ url: "https://news.example/1", title: "One", summary: "" }], NOW);
    store.recordSource("A", { ok: true, at: NOW, added: 1 });
    // What a stop in the middle of a write leaves: a temporary file next to the real one.
    writeFileSync(join(dir, "articles", "2026-10-10.json.123.tmp"), '{"version":1,"articles":[{"url":');
    // A file that cannot be read (a broken disk) does not take the rest down.
    writeFileSync(join(dir, "articles", "2026-10-09.json"), "{broken");
    const reopened = new NewsStore(dir);
    const log: string[] = [];
    reopened.recover((line) => log.push(line));
    assert.deepEqual(
      reopened.articlesIngestedAfter(new Date(0), NOW).map((a) => a.title),
      ["One"],
    );
    assert.equal(existsSync(join(dir, "articles", "2026-10-10.json.123.tmp")), false);
    assert.equal(existsSync(join(dir, "articles", "2026-10-09.json")), false);
    assert.ok(readdirSync(join(dir, "articles")).some((name) => name.startsWith("2026-10-09.json.corrupt-")));
    assert.match(log.join("\n"), /2026-10-09\.json/);
    assert.equal(reopened.sources().A?.lastSuccessAt, NOW.toISOString());
  });

  it("never shows a reader a half-written file: writes replace the file whole", () => {
    const dir = storeDir();
    const store = new NewsStore(dir);
    store.addArticles("A", [{ url: "https://news.example/1", title: "One", summary: "" }], NOW);
    const before = readdirSync(join(dir, "articles"));
    store.addArticles("A", [{ url: "https://news.example/2", title: "Two", summary: "" }], NOW);
    assert.deepEqual(readdirSync(join(dir, "articles")), before, "no temporary files are left behind");
    const reader = new NewsStore(dir);
    assert.equal(reader.articlesIngestedAfter(new Date(0), NOW).length, 2);
  });

  it("keeps per-source status: failures in a row, the last error, the last success", () => {
    const store = new NewsStore(storeDir());
    store.recordSource("A", { ok: true, at: NOW, added: 3 });
    store.recordSource("A", { ok: false, at: new Date(NOW.getTime() + HOUR), error: "HTTP 503" });
    store.recordSource("A", { ok: false, at: new Date(NOW.getTime() + 2 * HOUR), error: "timed out" });
    assert.deepEqual(store.sources().A, {
      lastAttemptAt: new Date(NOW.getTime() + 2 * HOUR).toISOString(),
      lastSuccessAt: NOW.toISOString(),
      consecutiveFailures: 2,
      lastError: "timed out",
    });
    store.recordSource("A", { ok: true, at: new Date(NOW.getTime() + 3 * HOUR), added: 0 });
    assert.equal(store.sources().A?.consecutiveFailures, 0);
    assert.equal(store.sources().A?.lastError, undefined);
  });
});

describe("collectOnce", () => {
  it("takes in every source, RSS and Atom, and reports what is new", async () => {
    const web = new FakeWeb();
    web.route(FEED_A.url, rss([{ title: "A1", link: "https://a.example/1", summary: "first", pubDate: "Sat, 10 Oct 2026 20:00:00 GMT" }]));
    web.route(FEED_B.url, () => new Response(atom([{ title: "B1", href: "https://b.example/1", published: "2026-10-10T19:00:00Z" }]), { headers: { "content-type": "application/atom+xml" } }));
    const cfg = config([FEED_A, FEED_B]);
    const store = new NewsStore(cfg.storeDir);
    const result = await collectOnce({ config: cfg, store, fetch: web.fetch, now: () => NOW, sleep: async () => {} });
    assert.deepEqual(result, { added: 2, failed: [] });
    assert.deepEqual(
      store.articlesIngestedAfter(new Date(0), NOW).map((a) => [a.source, a.title, a.summary, a.publishedAt]),
      [
        ["Example A", "A1", "first", "2026-10-10T20:00:00.000Z"],
        ["Example B", "B1", "", "2026-10-10T19:00:00.000Z"],
      ],
    );
    const request = web.requests[0]!;
    assert.match(request.headers.get("user-agent") ?? "", /fraction-agents/);
    // The second round finds nothing new.
    const second = await collectOnce({ config: cfg, store, fetch: web.fetch, now: () => new Date(NOW.getTime() + HOUR), sleep: async () => {} });
    assert.deepEqual(second, { added: 0, failed: [] });
    assert.equal(store.articlesIngestedAfter(NOW, new Date(NOW.getTime() + HOUR)).length, 0);
  });

  it("retries a source that fails for a while, and gives up on one that refuses", async () => {
    const web = new FakeWeb();
    web.route(FEED_A.url, (_r, attempt) =>
      attempt < 3 ? new Response("busy", { status: 503 }) : new Response(rss([{ title: "A1", link: "https://a.example/1" }])),
    );
    web.route(FEED_B.url, () => new Response("gone", { status: 404 }));
    const cfg = config([FEED_A, FEED_B]);
    const store = new NewsStore(cfg.storeDir);
    const sleeps: number[] = [];
    const result = await collectOnce({ config: cfg, store, fetch: web.fetch, now: () => NOW, sleep: async (ms) => void sleeps.push(ms) });
    assert.equal(result.added, 1);
    assert.deepEqual(result.failed, ["Example B"]);
    assert.equal(web.count(FEED_A.url), 3);
    assert.equal(web.count(FEED_B.url), 1, "a 404 is not retried");
    assert.equal(sleeps.length, 2);
    assert.equal(store.sources()["Example B"]?.consecutiveFailures, 1);
    assert.match(store.sources()["Example B"]?.lastError ?? "", /HTTP 404/);
  });

  it("counts failures in a row across rounds, and keeps going with the other sources", async () => {
    const web = new FakeWeb();
    web.route(FEED_A.url, () => {
      throw new TypeError("fetch failed");
    });
    web.route(FEED_B.url, atom([{ title: "B1", href: "https://b.example/1" }]));
    const cfg = config([FEED_A, FEED_B]);
    const store = new NewsStore(cfg.storeDir);
    for (let round = 0; round < 3; round++) {
      await collectOnce({ config: cfg, store, fetch: web.fetch, now: () => new Date(NOW.getTime() + round * HOUR), sleep: async () => {} });
    }
    assert.equal(store.sources()["Example A"]?.consecutiveFailures, 3);
    assert.equal(store.sources()["Example A"]?.lastSuccessAt, undefined);
    assert.equal(store.sources()["Example B"]?.consecutiveFailures, 0);
    assert.equal(store.articlesIngestedAfter(new Date(0), new Date(NOW.getTime() + 3 * HOUR)).length, 1);
  });

  it("refuses a feed that is too large or not a feed", async () => {
    const web = new FakeWeb();
    web.route(FEED_A.url, () => new Response("x".repeat(6 * 1024 * 1024)));
    web.route(FEED_B.url, () => new Response("<html><body>hello</body></html>", { headers: { "content-type": "text/html" } }));
    const cfg = config([FEED_A, FEED_B]);
    const store = new NewsStore(cfg.storeDir);
    const result = await collectOnce({ config: cfg, store, fetch: web.fetch, now: () => NOW, sleep: async () => {} });
    assert.deepEqual(result.failed.sort(), ["Example A", "Example B"]);
    assert.match(store.sources()["Example A"]?.lastError ?? "", /larger than/);
    assert.match(store.sources()["Example B"]?.lastError ?? "", /not an RSS or Atom feed/);
  });

  it("asks with the last ETag and treats 304 as a success with nothing new", async () => {
    const web = new FakeWeb();
    web.route(FEED_A.url, (request) =>
      request.headers.get("if-none-match") === '"v1"'
        ? new Response(null, { status: 304 })
        : new Response(rss([{ title: "A1", link: "https://a.example/1" }]), { headers: { etag: '"v1"' } }),
    );
    const cfg = config([FEED_A]);
    const store = new NewsStore(cfg.storeDir);
    await collectOnce({ config: cfg, store, fetch: web.fetch, now: () => NOW, sleep: async () => {} });
    const later = new Date(NOW.getTime() + HOUR);
    const result = await collectOnce({ config: cfg, store, fetch: web.fetch, now: () => later, sleep: async () => {} });
    assert.deepEqual(result, { added: 0, failed: [] });
    assert.equal(web.requests[1]?.headers.get("if-none-match"), '"v1"');
    assert.equal(store.sources()["Example A"]?.lastSuccessAt, later.toISOString());
  });

  it("skips entries without a usable link, and deletes what is 30 days old", async () => {
    const web = new FakeWeb();
    web.route(FEED_A.url, rss([{ title: "No link", link: "" }, { title: "Ok", link: "https://a.example/ok" }]));
    const cfg = config([FEED_A]);
    const store = new NewsStore(cfg.storeDir);
    store.addArticles("Example A", [{ url: "https://a.example/ancient", title: "Ancient", summary: "" }], new Date(NOW.getTime() - 40 * DAY));
    await collectOnce({ config: cfg, store, fetch: web.fetch, now: () => NOW, sleep: async () => {} });
    assert.deepEqual(
      store.articlesIngestedAfter(new Date(0), NOW).map((a) => a.title),
      ["Ok"],
    );
  });
});

describe("runCollector", () => {
  it("takes in at once and then every interval, until stopped", async () => {
    const web = new FakeWeb();
    let n = 0;
    web.route(FEED_A.url, () => new Response(rss([{ title: `A${++n}`, link: `https://a.example/${n}` }])));
    const cfg = config([FEED_A]);
    const store = new NewsStore(cfg.storeDir);
    const controller = new AbortController();
    const waits: number[] = [];
    let clock = NOW.getTime();
    await runCollector({
      config: cfg,
      store,
      fetch: web.fetch,
      now: () => new Date(clock),
      sleep: async (ms, signal) => {
        if (ms === 60 * 60_000) {
          waits.push(ms);
          clock += ms;
          if (waits.length === 3) controller.abort();
          signal?.throwIfAborted();
        }
      },
      signal: controller.signal,
      log: () => {},
    });
    assert.equal(web.count(FEED_A.url), 3);
    assert.equal(store.articlesIngestedAfter(new Date(0), new Date(clock)).length, 3);
  });
});
