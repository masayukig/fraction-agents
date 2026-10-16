import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const script = join(import.meta.dirname, "..", "skills", "fraction-agents", "scripts", "agent.mjs");

const token = "eyJhbGciOiJSUzI1NiJ9.c2VjcmV0LXRva2VuLWZvci10ZXN0cw.c2lnbmF0dXJl";

// A stand-in for the a2a CLI: it records how it was started and prints something of its own.
const fakeA2a = `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_A2A_RECORD, JSON.stringify({
  argv: process.argv.slice(2),
  auth: process.env.A2ACLI_AUTH ?? null,
  agentCard: process.env.A2ACLI_AGENT_CARD ?? null,
}));
process.stdout.write("Task ID: task-1\\nContext ID: ctx-1\\nState: TASK_STATE_SUBMITTED\\n");
process.stderr.write("fake a2a stderr\\n");
process.exit(Number(process.env.FAKE_A2A_EXIT ?? "0"));
`;

interface Env {
  home: string;
  configDir: string;
  record: string;
  env: Record<string, string>;
}

function setup(options: { withA2a?: boolean } = {}): Env {
  const root = mkdtempSync(join(tmpdir(), "skill-agent-"));
  const home = join(root, "home");
  const configDir = join(home, ".config", "fraction-agents");
  mkdirSync(join(configDir, "tokens"), { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  if (options.withA2a !== false) {
    writeFileSync(join(bin, "a2a"), fakeA2a);
    chmodSync(join(bin, "a2a"), 0o755);
  }
  const record = join(root, "record.json");
  return {
    home,
    configDir,
    record,
    env: {
      HOME: home,
      PATH: `${bin}:${dirname(process.execPath)}`,
      FAKE_A2A_RECORD: record,
    },
  };
}

function writeToken(path: string, value = `${token}\n`, mode = 0o600): void {
  writeFileSync(path, value);
  chmodSync(path, mode);
}

function writeConfig(e: Env, config: unknown, path = join(e.configDir, "agents.json")): void {
  writeFileSync(path, JSON.stringify(config));
}

function standard(e: Env): void {
  writeToken(join(e.configDir, "tokens", "claude"));
  writeConfig(e, {
    tokenFile: "~/.config/fraction-agents/tokens/claude",
    agents: {
      "wiki-keeper": { url: "https://agents.example.test/wiki-keeper/" },
      reviewer: { url: "https://agents.example.test/reviewer/" },
    },
  });
}

function run(e: Env, args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...e.env, ...extraEnv },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function recorded(e: Env): { argv: string[]; auth: string | null; agentCard: string | null } {
  return JSON.parse(readFileSync(e.record, "utf8"));
}

function invoked(e: Env): boolean {
  try {
    readFileSync(e.record);
    return true;
  } catch {
    return false;
  }
}

describe("skills/fraction-agents/scripts/agent.mjs", () => {
  it("runs a2a against the named agent with its URL and token in the environment", () => {
    const e = setup();
    standard(e);
    const result = run(e, ["wiki-keeper", "send", "--async", "この記事を取り込んで"]);
    assert.equal(result.status, 0, result.stderr);
    const r = recorded(e);
    assert.deepEqual(r.argv, ["send", "--async", "この記事を取り込んで"]);
    assert.equal(r.agentCard, "https://agents.example.test/wiki-keeper/");
    assert.equal(r.auth, `Bearer ${token}`);
  });

  it("never puts the token on a2a's command line or in its own output", () => {
    const e = setup();
    standard(e);
    const result = run(e, ["reviewer", "task", "get", "task-1", "--wait"]);
    assert.equal(result.status, 0, result.stderr);
    const r = recorded(e);
    assert.equal(r.agentCard, "https://agents.example.test/reviewer/");
    assert.ok(!r.argv.join(" ").includes(token));
    assert.ok(!r.argv.some((arg) => /bearer|--auth/i.test(arg)));
    assert.ok(!result.stdout.includes(token));
    assert.ok(!result.stderr.includes(token));
  });

  it("passes --task-id through so an input-required task can be answered", () => {
    const e = setup();
    standard(e);
    const result = run(e, ["wiki-keeper", "send", "--async", "--task-id", "task-1", "ページ名は「A2A」で"]);
    assert.equal(result.status, 0, result.stderr);
    const r = recorded(e);
    assert.deepEqual(r.argv, ["send", "--async", "--task-id", "task-1", "ページ名は「A2A」で"]);
    assert.equal(r.agentCard, "https://agents.example.test/wiki-keeper/");
    assert.equal(r.auth, `Bearer ${token}`);
  });

  it("passes a2a's output and exit status through", () => {
    const e = setup();
    standard(e);
    const result = run(e, ["wiki-keeper", "task", "get", "task-1", "--wait"], { FAKE_A2A_EXIT: "5" });
    assert.equal(result.status, 5);
    assert.match(result.stdout, /Task ID: task-1/);
    assert.match(result.stderr, /fake a2a stderr/);
  });

  it("replaces an A2ACLI_AUTH or A2ACLI_AGENT_CARD already in the environment", () => {
    const e = setup();
    standard(e);
    const result = run(e, ["wiki-keeper", "card", "get"], {
      A2ACLI_AUTH: "Bearer someone-else",
      A2ACLI_AGENT_CARD: "https://elsewhere.example.test/",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(recorded(e).auth, `Bearer ${token}`);
    assert.equal(recorded(e).agentCard, "https://agents.example.test/wiki-keeper/");
  });

  it("lets an agent use its own token file", () => {
    const e = setup();
    writeToken(join(e.configDir, "tokens", "claude"));
    writeToken(join(e.configDir, "tokens", "owner"), "owner-token\n");
    writeConfig(e, {
      tokenFile: "tokens/claude",
      agents: {
        "wiki-keeper": { url: "https://agents.example.test/wiki-keeper/", tokenFile: "tokens/owner" },
      },
    });
    const result = run(e, ["wiki-keeper", "task", "list"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(recorded(e).auth, "Bearer owner-token");
  });

  it("reads the config from XDG_CONFIG_HOME, or from FRACTION_AGENTS_CLIENT_CONFIG", () => {
    const e = setup();
    const xdg = join(e.home, "xdg");
    mkdirSync(join(xdg, "fraction-agents"), { recursive: true });
    writeToken(join(xdg, "fraction-agents", "token"));
    writeConfig(
      e,
      { tokenFile: "token", agents: { a: { url: "https://agents.example.test/a/" } } },
      join(xdg, "fraction-agents", "agents.json"),
    );
    assert.equal(run(e, ["a", "card", "get"], { XDG_CONFIG_HOME: xdg }).status, 0);
    assert.equal(recorded(e).agentCard, "https://agents.example.test/a/");

    const other = join(e.home, "elsewhere.json");
    writeConfig(e, { tokenFile: join(xdg, "fraction-agents", "token"), agents: { b: { url: "https://agents.example.test/b/" } } }, other);
    assert.equal(run(e, ["b", "card", "get"], { FRACTION_AGENTS_CLIENT_CONFIG: other }).status, 0);
    assert.equal(recorded(e).agentCard, "https://agents.example.test/b/");
  });

  it("lists the configured agents without reading or showing tokens", () => {
    const e = setup();
    standard(e);
    const result = run(e, ["--list"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /wiki-keeper\s+https:\/\/agents\.example\.test\/wiki-keeper\//);
    assert.match(result.stdout, /reviewer\s+https:\/\/agents\.example\.test\/reviewer\//);
    assert.ok(!result.stdout.includes(token));
    assert.ok(!invoked(e));
  });

  it("refuses an unknown agent and names the known ones", () => {
    const e = setup();
    standard(e);
    const result = run(e, ["nobody", "send", "hello"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nobody/);
    assert.match(result.stderr, /wiki-keeper/);
    assert.ok(!invoked(e));
  });

  it("refuses a token file that others can read, without showing the token", () => {
    const e = setup();
    standard(e);
    chmodSync(join(e.configDir, "tokens", "claude"), 0o644);
    const result = run(e, ["wiki-keeper", "send", "hello"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /0600/);
    assert.ok(!result.stderr.includes(token));
    assert.ok(!result.stdout.includes(token));
    assert.ok(!invoked(e));
  });

  it("refuses a missing or empty token file", () => {
    const e = setup();
    standard(e);
    writeToken(join(e.configDir, "tokens", "claude"), "\n");
    let result = run(e, ["wiki-keeper", "send", "hello"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /empty/);

    writeConfig(e, { tokenFile: "tokens/missing", agents: { a: { url: "https://agents.example.test/a/" } } });
    result = run(e, ["a", "send", "hello"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tokens\/missing/);
    assert.ok(!invoked(e));
  });

  it("explains a missing or broken config", () => {
    const e = setup();
    let result = run(e, ["wiki-keeper", "send", "hello"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /agents\.json/);

    writeConfig(e, { agents: { a: { url: "https://agents.example.test/a/" } } });
    result = run(e, ["a", "send", "hello"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tokenFile/);

    writeToken(join(e.configDir, "tokens", "claude"));
    writeConfig(e, { tokenFile: "tokens/claude", agents: { a: { url: "not a url" } } });
    result = run(e, ["a", "send", "hello"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /url/);
    assert.ok(!invoked(e));
  });

  it("explains how to install a2a when it is not on PATH", () => {
    const e = setup({ withA2a: false });
    standard(e);
    const result = run(e, ["wiki-keeper", "send", "hello"]);
    assert.equal(result.status, 127);
    assert.match(result.stderr, /a2a/);
    assert.ok(!result.stderr.includes(token));
  });

  it("prints usage when called without an agent or a2a arguments", () => {
    const e = setup();
    standard(e);
    for (const args of [[], ["wiki-keeper"]]) {
      const result = run(e, args);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /usage/i);
    }
    assert.ok(!invoked(e));
  });
});

// A stand-in for an agent's report endpoints (ADR 0020). It records each request and answers from `respond`.
interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
}

async function reportServer(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ base: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const reportId = "0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";

// The report endpoints as the host serves them, for one report owned by the caller.
function reportEndpoints(req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/deep-researcher/, "");
  if (req.method === "GET" && path === "/reports") {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        reports: [
          { id: reportId, title: "Rust の非同期ランタイムの比較", createdAt: "2026-10-15T01:02:03.000Z", partial: true },
          { id: "1c7d2e3f-4051-4b6c-9d7e-8f9a0b1c2d3e", title: "前の調べもの", createdAt: "2026-10-14T00:00:00.000Z", partial: false },
        ],
      }),
    );
    return;
  }
  if (req.method === "GET" && path === `/reports/${reportId}.md`) {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.end("# レポート\n\n本文\n");
    return;
  }
  if (req.method === "GET" && path === `/reports/${reportId}.html`) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<!doctype html><title>レポート</title><p>本文</p>\n");
    return;
  }
  if (req.method === "DELETE" && path === `/reports/${reportId}`) {
    res.statusCode = 204;
    res.end();
    return;
  }
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "report not found" }));
}

function reportsConfig(e: Env, url: string): void {
  writeToken(join(e.configDir, "tokens", "claude"));
  writeConfig(e, { tokenFile: "tokens/claude", agents: { "deep-researcher": { url } } });
}

// spawnSync would block the stand-in server in this same process, so the report commands run asynchronously.
function runAsync(e: Env, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: e.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("skills/fraction-agents/scripts/agent.mjs report", () => {
  it("lists the caller's reports with the token in the Authorization header only", async () => {
    const server = await reportServer(reportEndpoints);
    try {
      const e = setup();
      reportsConfig(e, `${server.base}/`);
      const result = await runAsync(e, ["deep-researcher", "report", "list"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(server.seen, [{ method: "GET", url: "/reports", authorization: `Bearer ${token}` }]);
      const lines = result.stdout.trimEnd().split("\n");
      assert.equal(lines.length, 2);
      assert.match(lines[0]!, new RegExp(`^${reportId}\\s+2026-10-15T01:02:03.000Z\\s+\\[partial\\] Rust の非同期ランタイムの比較$`));
      assert.match(lines[1]!, /^1c7d2e3f-4051-4b6c-9d7e-8f9a0b1c2d3e\s+2026-10-14T00:00:00.000Z\s+前の調べもの$/);
      assert.ok(!result.stdout.includes(token));
      assert.ok(!result.stderr.includes(token));
      assert.ok(!invoked(e));
    } finally {
      await server.close();
    }
  });

  it("prints the list as JSON with --json, and says so when there are no reports", async () => {
    const server = await reportServer(reportEndpoints);
    try {
      const e = setup();
      reportsConfig(e, `${server.base}/`);
      const result = await runAsync(e, ["deep-researcher", "report", "list", "--json"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).reports[0].id, reportId);
    } finally {
      await server.close();
    }
    const empty = await reportServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ reports: [] }));
    });
    try {
      const e = setup();
      reportsConfig(e, `${empty.base}/`);
      const result = await runAsync(e, ["deep-researcher", "report", "list"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /no reports/);
    } finally {
      await empty.close();
    }
  });

  it("gets a report's Markdown to standard output by default", async () => {
    const server = await reportServer(reportEndpoints);
    try {
      const e = setup();
      reportsConfig(e, `${server.base}/`);
      const result = await runAsync(e, ["deep-researcher", "report", "get", reportId]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "# レポート\n\n本文\n");
      assert.deepEqual(server.seen, [{ method: "GET", url: `/reports/${reportId}.md`, authorization: `Bearer ${token}` }]);
    } finally {
      await server.close();
    }
  });

  it("gets a report's HTML into a file with --output", async () => {
    const server = await reportServer(reportEndpoints);
    try {
      const e = setup();
      reportsConfig(e, `${server.base}/`);
      const output = join(e.home, "report.html");
      const result = await runAsync(e, ["deep-researcher", "report", "get", reportId, "--format", "html", "--output", output]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(readFileSync(output, "utf8"), "<!doctype html><title>レポート</title><p>本文</p>\n");
      assert.match(result.stderr, /report\.html/);
      assert.equal(server.seen[0]!.url, `/reports/${reportId}.html`);
    } finally {
      await server.close();
    }
  });

  it("builds the report URLs under an agent URL with a path", async () => {
    const server = await reportServer(reportEndpoints);
    try {
      const e = setup();
      reportsConfig(e, `${server.base}/deep-researcher`);
      const result = await runAsync(e, ["deep-researcher", "report", "get", reportId, "--format", "md"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(server.seen[0]!.url, `/deep-researcher/reports/${reportId}.md`);
    } finally {
      await server.close();
    }
  });

  it("deletes a report", async () => {
    const server = await reportServer(reportEndpoints);
    try {
      const e = setup();
      reportsConfig(e, `${server.base}/`);
      const result = await runAsync(e, ["deep-researcher", "report", "delete", reportId]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(server.seen, [{ method: "DELETE", url: `/reports/${reportId}`, authorization: `Bearer ${token}` }]);
      assert.match(result.stderr, /deleted/);
    } finally {
      await server.close();
    }
  });

  it("explains a report that is not there, and writes no file", async () => {
    const server = await reportServer(reportEndpoints);
    try {
      const e = setup();
      reportsConfig(e, `${server.base}/`);
      const other = "2d8e3f40-5162-4c7d-8e8f-9a0b1c2d3e4f";
      const output = join(e.home, "missing.md");
      let result = await runAsync(e, ["deep-researcher", "report", "get", other, "--output", output]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not found/);
      assert.match(result.stderr, new RegExp(other));
      assert.ok(!existsSync(output));

      result = await runAsync(e, ["deep-researcher", "report", "delete", other]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not found/);
    } finally {
      await server.close();
    }
  });

  it("explains an agent that keeps no reports", async () => {
    const server = await reportServer((_req, res) => {
      res.statusCode = 405;
      res.end();
    });
    try {
      const e = setup();
      reportsConfig(e, `${server.base}/`);
      const result = await runAsync(e, ["deep-researcher", "report", "list"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /405/);
    } finally {
      await server.close();
    }
    const notFound = await reportServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    try {
      const e = setup();
      reportsConfig(e, `${notFound.base}/`);
      const result = await runAsync(e, ["deep-researcher", "report", "list"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /keep(s)? no reports|does not keep reports/);
    } finally {
      await notFound.close();
    }
  });

  it("asks for a new token on 401 and 403, without showing the token", async () => {
    for (const status of [401, 403]) {
      const server = await reportServer((_req, res) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "refused" }));
      });
      try {
        const e = setup();
        reportsConfig(e, `${server.base}/`);
        const result = await runAsync(e, ["deep-researcher", "report", "get", reportId]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, new RegExp(String(status)));
        assert.match(result.stderr, /token/);
        assert.ok(!result.stderr.includes(token));
        assert.equal(result.stdout, "");
      } finally {
        await server.close();
      }
    }
  });

  it("does not follow a redirect with the token", async () => {
    const server = await reportServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", "http://127.0.0.1:9/elsewhere");
      res.end();
    });
    try {
      const e = setup();
      reportsConfig(e, `${server.base}/`);
      const result = await runAsync(e, ["deep-researcher", "report", "get", reportId]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /302/);
      assert.equal(server.seen.length, 1);
    } finally {
      await server.close();
    }
  });

  it("exits 3 when the agent cannot be reached", async () => {
    const server = await reportServer(reportEndpoints);
    const base = server.base;
    await server.close();
    const e = setup();
    reportsConfig(e, `${base}/`);
    const result = await runAsync(e, ["deep-researcher", "report", "list"]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /reach/);
    assert.ok(!result.stderr.includes(token));
  });

  it("refuses wrong report arguments before reading the token or sending anything", async () => {
    const server = await reportServer(reportEndpoints);
    try {
      const e = setup();
      reportsConfig(e, `${server.base}/`);
      for (const args of [
        ["report"],
        ["report", "show"],
        ["report", "get"],
        ["report", "get", reportId, "--format", "pdf"],
        ["report", "get", reportId, "--output"],
        ["report", "get", "../etc/passwd"],
        ["report", "delete"],
        ["report", "delete", reportId, "extra"],
        ["report", "list", "extra"],
      ]) {
        const result = await runAsync(e, ["deep-researcher", ...args]);
        assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
        assert.match(result.stderr, /usage/i);
      }
      assert.equal(server.seen.length, 0);
      assert.ok(!invoked(e));
    } finally {
      await server.close();
    }
  });
});
