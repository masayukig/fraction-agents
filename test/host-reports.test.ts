import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { Config } from "../src/config.ts";
import { REPLY_EXTENSION_URI } from "../src/reply.ts";
import {
  makeConfig,
  post,
  resultText,
  send,
  start,
  stop,
  tempDir,
  waitForTask,
  type Json,
} from "./fixtures/host-harness.ts";

const REPLY = {
  summary: "Rust の async の現状\nTokio が主流。",
  sections: [
    { title: "ランタイム", body: "Tokio と smol。\n\n```mermaid\ngraph TD; A-->B\n```" },
  ],
  sources: [{ title: "Tokio", url: "https://tokio.rs/" }],
};
const RENDERED = [
  "Rust の async の現状\nTokio が主流。",
  "## ランタイム\n\nTokio と smol。\n\n```mermaid\ngraph TD; A-->B\n```",
  "## Sources\n\n- [Tokio](https://tokio.rs/)",
].join("\n\n");

const ISSUER = "https://auth.example.test";
const PAGES = "https://reports.example.test/";
const ALICE = "github:alice";
const signing = generateKeyPairSync("ed25519");
let jwksServer: Server;
let jwksUrl: string;

before(async () => {
  const jwk = { ...signing.publicKey.export({ format: "jwk" }), kid: "key-1" };
  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/__gated/jwks.json`;
});

after(() => jwksServer.close());

function assertion(subject = ALICE): string {
  const seconds = Math.floor(Date.now() / 1000);
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = b64({ alg: "EdDSA", typ: "gated-assertion+jwt", kid: "key-1" });
  const body = b64({ iss: ISSUER, sub: subject, aud: "reports.example.test", iat: seconds, exp: seconds + 60 });
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), signing.privateKey).toString("base64url")}`;
}

function reportsConfig(overrides: Record<string, unknown> = {}, web = false): Config {
  return makeConfig(tempDir(), {
    reports: web
      ? { web: { port: 18081, publicUrl: PAGES, gated: { issuer: ISSUER, jwksUrl }, allowedSubjects: [ALICE] } }
      : {},
    ...overrides,
  });
}

async function get(url: string, token?: string, method = "GET"): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await fetch(url, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

async function research(url: string, token = "owner", text = `reply:${JSON.stringify(REPLY)}`, extra: Json = {}): Promise<Json> {
  const task = await send(url, token, text, extra);
  const done = await waitForTask(url, token, task.id);
  assert.equal(done.status.state, "TASK_STATE_COMPLETED");
  return done;
}

describe("reports for machines", () => {
  it("keeps the reply of a completed task as a report under its taskId", async () => {
    const { url } = await start(reportsConfig());
    const done = await research(url);
    const list = await get(`${url}/reports`, "owner");
    assert.equal(list.status, 200);
    const [report] = JSON.parse(list.text).reports;
    assert.equal(report.id, done.id);
    assert.equal(report.title, "Rust の async の現状");
    assert.equal(report.partial, false);
    assert.match(report.createdAt, /^\d{4}-\d{2}-\d{2}T/);

    const markdown = await get(`${url}/reports/${done.id}.md`, "owner");
    assert.equal(markdown.status, 200);
    assert.equal(markdown.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(markdown.text, RENDERED);
    for (const response of [list, markdown]) {
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    }

    const html = await get(`${url}/reports/${done.id}.html`, "owner");
    assert.equal(html.status, 200);
    assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(html.text, /<pre class="mermaid">/);
    assert.doesNotMatch(html.text, /<script/);
  });

  it("makes no report of a task without a reply, or one that failed", async () => {
    const config = reportsConfig();
    const { url } = await start(config);
    await research(url, "owner", "hello");
    const failed = await send(url, "owner", `reply-then-fail:${JSON.stringify(REPLY)}`);
    assert.equal((await waitForTask(url, "owner", failed.id)).status.state, "TASK_STATE_FAILED");
    assert.deepEqual(JSON.parse((await get(`${url}/reports`, "owner")).text).reports, []);
    assert.deepEqual(readdirSync(config.reports!.dir), []);
  });

  it("serves and deletes a report for its owner only, and answers 404 to anyone else", async () => {
    const { url } = await start(reportsConfig());
    const done = await research(url);
    assert.deepEqual(JSON.parse((await get(`${url}/reports`, "claude")).text).reports, []);
    for (const path of [`${done.id}.md`, `${done.id}.html`]) {
      assert.equal((await get(`${url}/reports/${path}`, "claude")).status, 404);
    }
    assert.equal((await get(`${url}/reports/${done.id}`, "claude", "DELETE")).status, 404);
    assert.equal((await get(`${url}/reports/${crypto.randomUUID()}.md`, "owner")).status, 404);
    assert.equal((await get(`${url}/reports/..%2Fstate.db.md`, "owner")).status, 404);

    const deleted = await get(`${url}/reports/${done.id}`, "owner", "DELETE");
    assert.equal(deleted.status, 204);
    assert.equal((await get(`${url}/reports/${done.id}.md`, "owner")).status, 404);
    assert.equal((await get(`${url}/reports/${done.id}`, "owner", "DELETE")).status, 404);
    const task = await waitForTask(url, "owner", done.id);
    assert.equal(task.status.state, "TASK_STATE_COMPLETED", "the task stays");
  });

  it("asks for the same token as the A2A calls", async () => {
    const { url } = await start(reportsConfig());
    assert.equal((await get(`${url}/reports`)).status, 401);
    assert.equal((await get(`${url}/reports`, "stranger")).status, 403);
  });

  it("marks the report of a task that stopped at its time limit", async () => {
    const { url } = await start(reportsConfig({ taskTimeLimitSeconds: 0.2, taskTimeLimitGraceSeconds: 0.2 }));
    const done = await research(url, "owner", `reply-then-wait:${JSON.stringify(REPLY)}`);
    const [report] = JSON.parse((await get(`${url}/reports`, "owner")).text).reports;
    assert.equal(report.partial, true);
    const markdown = (await get(`${url}/reports/${done.id}.md`, "owner")).text;
    assert.match(markdown, /^> .*時間の上限/);
    assert.ok(markdown.endsWith(RENDERED));
  });

  it("keeps reports past the context's retention and across a restart", async () => {
    let now = Date.now();
    const config = reportsConfig({ sessionRetentionSeconds: 60 });
    const first = await start(config, () => now);
    const done = await research(first.url);
    now += 120_000;
    await first.host.sweep();
    await stop(first.host);
    const second = await start(config);
    assert.equal((await get(`${second.url}/reports/${done.id}.md`, "owner")).text, RENDERED);
  });

  it("does nothing of the kind without the setting", async () => {
    const config = makeConfig(tempDir());
    const { url } = await start(config);
    const done = await research(url);
    assert.equal(resultText(done), RENDERED);
    assert.notEqual((await get(`${url}/reports`, "owner")).status, 200);
    assert.equal(existsSync(join(config.dataDir, "reports")), false);
  });
});

describe("the link in the reply", () => {
  it("adds a section with the page's URL to the reply, in the text and the data part, but not to the report", async () => {
    const { url } = await start(reportsConfig({}, true));
    const { body } = await post(
      url,
      "owner",
      "SendMessage",
      { message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text: `reply:${JSON.stringify(REPLY)}` }] } },
      { "a2a-extensions": REPLY_EXTENSION_URI },
    );
    const task = body.result.task;
    const link = `${PAGES}reports/${task.id}`;
    const [text, data] = task.artifacts[0].parts;
    assert.equal(text.text, `${RENDERED.replace(/\n\n## Sources[\s\S]*$/, "")}\n\n## レポート\n\n${link}\n\n## Sources\n\n- [Tokio](https://tokio.rs/)`);
    assert.deepEqual(data.data.sections.at(-1), { title: "レポート", body: link });
    assert.equal((await get(`${url}/reports/${task.id}.md`, "owner")).text, RENDERED);
  });

  it("adds no section when the reply already has 50", async () => {
    const { url } = await start(reportsConfig({}, true));
    const full = { ...REPLY, sections: Array.from({ length: 50 }, (_, index) => ({ title: `S${index}`, body: "b" })) };
    const done = await research(url, "owner", `reply:${JSON.stringify(full)}`);
    assert.doesNotMatch(resultText(done), /## レポート/);
  });

  it("adds no section without the pages for people", async () => {
    const { url } = await start(reportsConfig());
    assert.equal(resultText(await research(url)), RENDERED);
  });
});

describe("pages for people", () => {
  async function startWeb(): Promise<{ url: string; web: string }> {
    const running = await start(reportsConfig({}, true));
    const web = await running.host.listenWeb(0, "127.0.0.1");
    return { url: running.url, web };
  }

  /** `null` sends no assertion at all. */
  async function open(url: string, method = "GET", subject: string | null = ALICE): Promise<{ status: number; text: string; headers: Headers }> {
    const response = await fetch(url, { method, headers: subject === null ? {} : { "gated-assertion": assertion(subject) } });
    return { status: response.status, text: await response.text(), headers: response.headers };
  }

  it("lists every caller's reports, newest first, and shows each one with its diagrams", async () => {
    const { url, web } = await startWeb();
    const first = await research(url, "owner");
    const second = await research(url, "claude", `reply:${JSON.stringify({ ...REPLY, summary: "Second <b>one</b>" })}`);
    const list = await open(`${web}/`);
    assert.equal(list.status, 200);
    assert.equal(list.headers.get("content-type"), "text/html; charset=utf-8");
    assert.ok(list.text.indexOf(second.id) < list.text.indexOf(first.id));
    assert.match(list.text, /Second &lt;b&gt;one&lt;\/b&gt;/);
    assert.match(list.text, />claude</);

    const page = await open(`${web}/reports/${first.id}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /<script src="\.\.\/assets\/mermaid\.min\.js"><\/script>/);
    const markdown = await open(`${web}/reports/${first.id}.md`);
    assert.equal(markdown.text, RENDERED);
    assert.equal(markdown.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal((await open(`${web}/reports/${crypto.randomUUID()}`)).status, 404);
    assert.equal((await open(`${web}/reports/${first.id}`, "HEAD")).status, 200);
  });

  it("serves the diagram script and its starter from its own origin", async () => {
    const { web } = await startWeb();
    for (const name of ["mermaid.min.js", "report.js"]) {
      const asset = await open(`${web}/assets/${name}`);
      assert.equal(asset.status, 200, name);
      assert.match(asset.headers.get("content-type") ?? "", /^text\/javascript/);
    }
    const starter = (await open(`${web}/assets/report.js`)).text;
    assert.match(starter, /securityLevel: "strict"/);
    assert.equal((await open(`${web}/assets/../../package.json`)).status, 404);
  });

  it("puts the protective headers on every response, refusals too", async () => {
    const { web } = await startWeb();
    for (const response of [await open(`${web}/`), await open(`${web}/`, "GET", null), await open(`${web}/`, "POST")]) {
      const csp = response.headers.get("content-security-policy") ?? "";
      for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "connect-src 'none'", "form-action 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) {
        assert.ok(csp.includes(directive), `${directive} in ${csp}`);
      }
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    }
  });

  it("refuses a request without a valid assertion with 401, and a subject not allowed with 403, saying nothing", async () => {
    const { url, web } = await startWeb();
    const done = await research(url);
    const missing = await open(`${web}/reports/${done.id}`, "GET", null);
    assert.equal(missing.status, 401);
    assert.doesNotMatch(missing.text, /Rust/);
    const forged = await fetch(`${web}/`, { headers: { "gated-assertion": `${assertion()}x` } });
    assert.equal(forged.status, 401);
    const stranger = await open(`${web}/`, "GET", "github:mallory");
    assert.equal(stranger.status, 403);
    assert.doesNotMatch(stranger.text, /Rust|mallory/);
  });

  it("takes GET and HEAD only, and has no way to delete", async () => {
    const { url, web } = await startWeb();
    const done = await research(url);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      assert.equal((await open(`${web}/reports/${done.id}`, method)).status, 405, method);
    }
    assert.equal((await open(`${web}/reports/${done.id}`)).status, 200, "still there");
  });

  it("keeps the A2A calls, the Agent Card and the images off this listener, and the pages off the A2A one", async () => {
    const { url, web } = await startWeb();
    const done = await research(url);
    assert.equal((await open(`${web}/.well-known/agent-card.json`)).status, 404);
    assert.equal((await open(`${web}/healthz`)).status, 404);
    assert.equal((await open(`${web}/artifacts/${crypto.randomUUID()}`)).status, 404);
    assert.equal((await open(`${web}/reports`)).status, 404);
    assert.equal((await open(`${web}/reports/${done.id}.html`)).status, 404);
    assert.equal((await get(`${url}/reports/${done.id}`, "owner")).status, 404);
    assert.equal((await get(`${url}/assets/report.js`, "owner")).status, 404);
    assert.equal((await get(`${url}/`, "owner")).status === 200, false);
  });
});

describe("the owner", () => {
  it("is the caller that sent the task", async () => {
    const { url } = await start(reportsConfig());
    const done = await research(url, "claude");
    assert.equal((await get(`${url}/reports/${done.id}.md`, "claude")).status, 200);
    assert.equal((await get(`${url}/reports/${done.id}.md`, "owner")).status, 404);
  });
});
