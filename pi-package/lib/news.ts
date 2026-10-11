// The news agent (ADR 0017): its settings (news.json), the store of the articles taken in, and the collector that
// takes in every source on a timer of its own. The collector runs beside the host in the agent's pod
// (bin/news-collect.ts); the agent's tools only read the store. It imports nothing outside the package, so the
// collector runs it with plain node.
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { decodeFeed, parseFeed } from "./feed.ts";

// --- Settings ----------------------------------------------------------------------------------------------------

export interface NewsSource {
  /** Shown to the agent and used to keep the source's status. One line, unique. */
  name: string;
  /** How the source is taken in. Only `feed` (RSS and Atom) so far. */
  kind: "feed";
  url: string;
}

/** `news.json`: the sources to take in, and how often. It holds no secrets. */
export interface NewsConfig {
  /** An IANA time zone such as Asia/Tokyo. Times are shown in it. */
  timeZone: string;
  /** Minutes between two rounds of taking in. */
  intervalMinutes: number;
  /** Where the store is: a directory on the agent's volume, shared by the collector and the agent's tools. */
  storeDir: string;
  sources: NewsSource[];
}

/** The file name of the settings inside pi's agent directory. */
export const NEWS_CONFIG_FILE = "news.json";
export const DEFAULT_STORE_DIR = "/data/news";
export const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 1440;
const NAME_CHARS = 100;
const KINDS = ["feed"];

export function defaultNewsConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const agentDir = env.PI_CODING_AGENT_DIR;
  return agentDir ? join(agentDir, NEWS_CONFIG_FILE) : undefined;
}

export function loadNewsConfig(path: string): NewsConfig {
  return parseNewsConfig(JSON.parse(readFileSync(path, "utf8")));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuseUnknown(input: Record<string, unknown>, known: string[], where: string): void {
  const extra = Object.keys(input).filter((key) => !known.includes(key));
  if (extra.length > 0) throw new Error(`news: unknown settings${where}: ${extra.join(", ")}`);
}

export function parseNewsConfig(input: unknown): NewsConfig {
  if (!isRecord(input)) throw new Error("news: the settings must be an object");
  refuseUnknown(input, ["timeZone", "intervalMinutes", "storeDir", "sources"], "");

  const timeZone = input.timeZone ?? "UTC";
  if (typeof timeZone !== "string" || timeZone === "") throw new Error("news: timeZone must be an IANA time zone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`news: timeZone ${timeZone} is not a time zone`);
  }

  const intervalMinutes = input.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  if (
    typeof intervalMinutes !== "number" ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < MIN_INTERVAL_MINUTES ||
    intervalMinutes > MAX_INTERVAL_MINUTES
  ) {
    throw new Error(`news: intervalMinutes must be a whole number from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}`);
  }

  const storeDir = input.storeDir ?? DEFAULT_STORE_DIR;
  if (typeof storeDir !== "string" || !isAbsolute(storeDir)) throw new Error("news: storeDir must be an absolute path");

  if (!Array.isArray(input.sources)) throw new Error("news: sources must be a list of {name, kind, url}");
  if (input.sources.length === 0) throw new Error("news: sources must have at least one source");
  const names = new Set<string>();
  const urls = new Set<string>();
  const sources = input.sources.map((value, index): NewsSource => {
    const where = `sources[${index}]`;
    if (!isRecord(value)) throw new Error(`news: ${where} must be an object of name, kind and url`);
    refuseUnknown(value, ["name", "kind", "url"], ` in ${where}`);
    const { name, kind, url } = value;
    if (typeof name !== "string" || name.trim() === "" || /[\r\n]/.test(name) || [...name].length > NAME_CHARS) {
      throw new Error(`news: ${where}.name must be one line of up to ${NAME_CHARS} characters`);
    }
    if (typeof kind !== "string" || !KINDS.includes(kind)) throw new Error(`news: ${where}.kind must be one of: ${KINDS.join(", ")}`);
    if (typeof url !== "string" || !/^https?:\/\/\S+$/i.test(url) || !URL.canParse(url)) {
      throw new Error(`news: ${where}.url must be an http or https URL`);
    }
    if (names.has(name)) throw new Error(`news: the source name ${JSON.stringify(name)} is used twice`);
    if (urls.has(url)) throw new Error(`news: the source URL ${url} is listed twice`);
    names.add(name);
    urls.add(url);
    return { name, kind: "feed", url };
  });
  return { timeZone, intervalMinutes, storeDir, sources };
}

// --- URLs and times ----------------------------------------------------------------------------------------------

/** Query parameters that only say where a click came from. Two URLs that differ only in these are one article. */
const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|mkt_tok)$/i;

/**
 * The key an article is kept under: an absolute http(s) URL without its fragment, the tracking parameters and the
 * default port, with the query sorted. The scheme and the host are lower case; the path is kept as written.
 * `undefined` for what is not an http(s) URL.
 */
export function normalizeUrl(raw: string, base?: string): string | undefined {
  const value = raw.trim();
  if (value === "") return undefined;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  url.hash = "";
  for (const key of [...new Set(url.searchParams.keys())]) if (TRACKING.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  if ([...url.searchParams.keys()].length === 0) url.search = "";
  return url.href;
}

const ISO_TIME = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?/i;

/**
 * The time of the line 前回の受け取り (ADR 0017): ISO 8601 with a UTC offset, such as
 * `2026-10-11T07:00:00+09:00`. A zone in brackets after it (`(JST)`, `(Asia/Tokyo)`) and the label before it are
 * allowed and ignored: the offset decides. A time without an offset is refused rather than guessed.
 */
export function parseSince(text: string): Date {
  const match = ISO_TIME.exec(text);
  if (!match) {
    if (/\d{4}-\d{2}-\d{2}/.test(text)) {
      throw new Error(`since must be a time with a UTC offset, such as 2026-10-11T07:00:00+09:00; got ${JSON.stringify(text)}`);
    }
    throw new Error(`since is not an ISO 8601 time with an offset, such as 2026-10-11T07:00:00+09:00; got ${JSON.stringify(text)}`);
  }
  if (!match[2]) throw new Error(`since has no UTC offset; write it as 2026-10-11T07:00:00+09:00; got ${JSON.stringify(text)}`);
  const ms = Date.parse(`${match[1]}${match[2]}`);
  if (!Number.isFinite(ms)) throw new Error(`since is not an ISO 8601 time with an offset; got ${JSON.stringify(text)}`);
  return new Date(ms);
}

// --- Store -------------------------------------------------------------------------------------------------------

export const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 86_400_000;

export interface Article {
  /** A short ID from the URL. */
  id: string;
  /** The normalized URL: the key that keeps an article once. */
  url: string;
  title: string;
  summary: string;
  /** The source's name in news.json. */
  source: string;
  /** ISO 8601, when the feed says. */
  publishedAt?: string;
  /** ISO 8601: when the collector took it in. "New" is decided by this, not by the publication time. */
  ingestedAt: string;
}

export interface ArticleCandidate {
  url: string;
  title: string;
  summary: string;
  publishedAt?: Date;
}

export interface SourceStatus {
  lastAttemptAt: string;
  lastSuccessAt?: string;
  consecutiveFailures: number;
  lastError?: string;
}

/** What a conditional request needs: the validators of the last full response. */
interface Validators {
  etag?: string;
  lastModified?: string;
}

type SourceRecord = SourceStatus & { validators?: Validators };

export type SourceOutcome =
  | { ok: true; at: Date; added: number; validators?: Validators }
  | { ok: false; at: Date; error: string };

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const ARTICLES = "articles";
const SOURCES = "sources.json";

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Write the whole file next to its place, flush it, and move it into place. A reader sees the old file or the new
 * one, never half of one; a stop in the middle leaves the old file and a temporary file that recovery removes.
 */
function replaceFile(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const dir = openSync(join(path, ".."), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

function isArticle(value: unknown): value is Article {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.url === "string" &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    typeof value.source === "string" &&
    typeof value.ingestedAt === "string" &&
    (value.publishedAt === undefined || typeof value.publishedAt === "string")
  );
}

function readDay(path: string): Article[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.articles) || !parsed.articles.every(isArticle)) {
    throw new Error("not a file of articles");
  }
  return parsed.articles;
}

/**
 * The articles taken in, one file per day (UTC) of taking in under `articles/`, and the sources' status in
 * `sources.json`. Only the collector writes; the agent's tools read. Every write replaces a file whole.
 */
export class NewsStore {
  readonly dir: string;
  readonly #articlesDir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.#articlesDir = join(dir, ARTICLES);
  }

  #dayFiles(): { day: string; path: string }[] {
    let names: string[];
    try {
      names = readdirSync(this.#articlesDir);
    } catch {
      return [];
    }
    return names
      .map((name) => DAY_FILE.exec(name)?.[1])
      .filter((day): day is string => day !== undefined)
      .sort()
      .map((day) => ({ day, path: join(this.#articlesDir, `${day}.json`) }));
  }

  /** A day's articles; nothing when the file is missing or cannot be read (recovery sets those aside). */
  #readDay(path: string): Article[] {
    try {
      return readDay(path);
    } catch {
      return [];
    }
  }

  #writeDay(day: string, articles: Article[]): void {
    const path = join(this.#articlesDir, `${day}.json`);
    if (articles.length === 0) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(this.#articlesDir, { recursive: true });
    replaceFile(path, JSON.stringify({ version: 1, articles }));
  }

  /**
   * Run once by the collector before it writes: removes temporary files a stop left behind, and sets aside files
   * that cannot be read, so that they are neither read nor overwritten.
   */
  recover(log: (line: string) => void = () => {}): void {
    for (const dir of [this.#articlesDir, this.dir]) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.endsWith(".tmp")) {
          rmSync(join(dir, name), { force: true });
          continue;
        }
        const isDay = dir === this.#articlesDir && DAY_FILE.test(name);
        const isSources = dir === this.dir && name === SOURCES;
        if (!isDay && !isSources) continue;
        try {
          if (isDay) readDay(join(dir, name));
          else this.#readSources(true);
        } catch (error) {
          const aside = `${name}.corrupt-${Date.now()}`;
          renameSync(join(dir, name), join(dir, aside));
          log(`news: ${join(dir, name)} could not be read (${error instanceof Error ? error.message : String(error)}); set aside as ${aside}`);
        }
      }
    }
  }

  /** Every article kept, oldest first. */
  all(): Article[] {
    return this.#dayFiles().flatMap(({ path }) => this.#readDay(path));
  }

  /** Keeps the candidates not kept yet (by normalized URL), taken in at `ingestedAt`. Returns those it kept. */
  addArticles(source: string, candidates: ArticleCandidate[], ingestedAt: Date): Article[] {
    const known = new Set(this.all().map((article) => article.url));
    const at = ingestedAt.toISOString();
    const added: Article[] = [];
    for (const candidate of candidates) {
      const url = normalizeUrl(candidate.url);
      if (!url || known.has(url)) continue;
      known.add(url);
      added.push({
        id: createHash("sha256").update(url).digest("hex").slice(0, 12),
        url,
        title: candidate.title.trim() || "(no title)",
        summary: candidate.summary,
        source,
        ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt.toISOString() } : {}),
        ingestedAt: at,
      });
    }
    if (added.length > 0) {
      const day = dayOf(at);
      this.#writeDay(day, [...this.#readDay(join(this.#articlesDir, `${day}.json`)), ...added]);
    }
    return added;
  }

  /**
   * The articles taken in strictly after `since`, oldest first. Never older than {@link RETENTION_DAYS} days
   * before `now`, whether or not the collector has deleted them yet.
   */
  articlesIngestedAfter(since: Date, now: Date): Article[] {
    const floor = Math.max(since.getTime(), now.getTime() - RETENTION_MS);
    const firstDay = dayOf(new Date(floor).toISOString());
    return this.#dayFiles()
      .filter(({ day }) => day >= firstDay)
      .flatMap(({ path }) => this.#readDay(path))
      .filter((article) => {
        const at = Date.parse(article.ingestedAt);
        return at > since.getTime() && at > now.getTime() - RETENTION_MS;
      })
      .sort((a, b) => Date.parse(a.ingestedAt) - Date.parse(b.ingestedAt));
  }

  /** Deletes the articles taken in {@link RETENTION_DAYS} days or more before `now`. Returns how many. */
  prune(now: Date): number {
    const limit = now.getTime() - RETENTION_MS;
    const limitDay = dayOf(new Date(limit).toISOString());
    let removed = 0;
    for (const { day, path } of this.#dayFiles()) {
      if (day > limitDay) continue;
      const articles = this.#readDay(path);
      const kept = articles.filter((article) => Date.parse(article.ingestedAt) > limit);
      if (kept.length === articles.length) continue;
      removed += articles.length - kept.length;
      this.#writeDay(day, kept);
    }
    return removed;
  }

  #readSources(strict = false): Record<string, SourceRecord> {
    let text: string;
    try {
      text = readFileSync(join(this.dir, SOURCES), "utf8");
    } catch {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.sources)) throw new Error("not a file of sources");
      return parsed.sources as Record<string, SourceRecord>;
    } catch (error) {
      if (strict) throw error;
      return {};
    }
  }

  /** Each source's status, by name. */
  sources(): Record<string, SourceStatus> {
    return Object.fromEntries(
      Object.entries(this.#readSources()).map(([name, { validators: _validators, ...status }]) => [name, status]),
    );
  }

  validators(name: string): Validators {
    return this.#readSources()[name]?.validators ?? {};
  }

  recordSource(name: string, outcome: SourceOutcome): void {
    const all = this.#readSources();
    const before = all[name];
    const at = outcome.at.toISOString();
    const record: SourceRecord = outcome.ok
      ? {
          lastAttemptAt: at,
          lastSuccessAt: at,
          consecutiveFailures: 0,
          ...(outcome.validators ? { validators: outcome.validators } : before?.validators ? { validators: before.validators } : {}),
        }
      : {
          lastAttemptAt: at,
          ...(before?.lastSuccessAt ? { lastSuccessAt: before.lastSuccessAt } : {}),
          consecutiveFailures: (before?.consecutiveFailures ?? 0) + 1,
          lastError: outcome.error,
          ...(before?.validators ? { validators: before.validators } : {}),
        };
    all[name] = record;
    mkdirSync(this.dir, { recursive: true });
    replaceFile(join(this.dir, SOURCES), JSON.stringify({ version: 1, sources: all }));
  }
}

// --- Collector ---------------------------------------------------------------------------------------------------

export const FEED_MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 2_000;
const RETRY_AFTER_LIMIT_MS = 60_000;
const USER_AGENT = "fraction-agents-news/0.1 (+https://github.com/yuanying/fraction-agents)";

export interface CollectOptions {
  config: NewsConfig;
  store: NewsStore;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Waits between attempts and between rounds. Rejects when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

class FetchFailure extends Error {
  readonly retry: boolean;
  readonly waitMs: number | undefined;

  constructor(message: string, retry: boolean, waitMs?: number) {
    super(message);
    this.retry = retry;
    this.waitMs = waitMs;
  }
}

type Fetched = { notModified: true } | { notModified: false; bytes: Uint8Array; contentType?: string; validators: Validators };

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError") return `no response within ${FETCH_TIMEOUT_MS / 1000} seconds`;
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

function retryAfter(value: string | null, now: Date): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now.getTime();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, RETRY_AFTER_LIMIT_MS) : undefined;
}

async function readLimited(response: Response): Promise<Uint8Array> {
  const tooLarge = () => new FetchFailure(`the feed is larger than ${FEED_MAX_BYTES / 1024 / 1024} MB`, false);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > FEED_MAX_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > FEED_MAX_BYTES) throw tooLarge();
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

async function attempt(source: NewsSource, validators: Validators, options: Required<Pick<CollectOptions, "fetch" | "now">> & { signal?: AbortSignal }): Promise<Fetched> {
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
  };
  if (validators.etag) headers["if-none-match"] = validators.etag;
  if (validators.lastModified) headers["if-modified-since"] = validators.lastModified;
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await options.fetch(source.url, {
      headers,
      redirect: "follow",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new FetchFailure(describe(error), true);
  }
  if (response.status === 304) return { notModified: true };
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel();
    throw new FetchFailure(`HTTP ${response.status} ${response.statusText}`.trim(), true, retryAfter(response.headers.get("retry-after"), options.now()));
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new FetchFailure(`HTTP ${response.status} ${response.statusText}`.trim(), false);
  }
  const bytes = await readLimited(response);
  const etag = response.headers.get("etag") ?? undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;
  return {
    notModified: false,
    bytes,
    contentType: response.headers.get("content-type") ?? undefined,
    validators: { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) },
  };
}

/** Fetches a feed, trying again after failures that may pass (no answer, 429, 5xx): up to 3 tries. */
async function fetchFeed(source: NewsSource, validators: Validators, options: CollectOptions): Promise<Fetched> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  for (let n = 1; ; n++) {
    try {
      return await attempt(source, validators, { fetch: fetchImpl, now, signal: options.signal });
    } catch (error) {
      if (!(error instanceof FetchFailure) || !error.retry || n >= MAX_ATTEMPTS) throw error;
      await sleep(error.waitMs ?? BACKOFF_MS * 4 ** (n - 1), options.signal);
    }
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal });
}

/**
 * One round: takes in every source in turn, keeping each one's new articles before going on to the next, then
 * deletes what is 30 days old. A source that fails is recorded and left for the next round.
 */
export async function collectOnce(options: CollectOptions): Promise<{ added: number; failed: string[] }> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const { store } = options;
  let added = 0;
  const failed: string[] = [];
  for (const source of options.config.sources) {
    options.signal?.throwIfAborted();
    try {
      const fetched = await fetchFeed(source, store.validators(source.name), options);
      if (fetched.notModified) {
        store.recordSource(source.name, { ok: true, at: now(), added: 0 });
        continue;
      }
      const feed = parseFeed(decodeFeed(fetched.bytes, fetched.contentType), source.url);
      const candidates = feed.entries.flatMap((entry) => (entry.url ? [{ ...entry, url: entry.url }] : []));
      const kept = store.addArticles(source.name, candidates, now());
      added += kept.length;
      store.recordSource(source.name, { ok: true, at: now(), added: kept.length, validators: fetched.validators });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      failed.push(source.name);
      log(`news: ${source.name}: ${message}`);
      try {
        store.recordSource(source.name, { ok: false, at: now(), error: message.slice(0, 300) });
      } catch (recordError) {
        log(`news: could not record the status of ${source.name}: ${describe(recordError)}`);
      }
    }
  }
  const removed = store.prune(now());
  log(`news: took in ${added} new article(s) from ${options.config.sources.length - failed.length} of ${options.config.sources.length} source(s); deleted ${removed} older than ${RETENTION_DAYS} days${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
  return { added, failed };
}

/** Takes in at once and then every `intervalMinutes`, until the signal aborts. */
export async function runCollector(options: CollectOptions): Promise<void> {
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? defaultSleep;
  options.store.recover(log);
  while (!options.signal?.aborted) {
    try {
      await collectOnce(options);
    } catch (error) {
      if (options.signal?.aborted) break;
      log(`news: the round failed: ${describe(error)}`);
    }
    try {
      await sleep(options.config.intervalMinutes * 60_000, options.signal);
    } catch {
      break;
    }
  }
}
