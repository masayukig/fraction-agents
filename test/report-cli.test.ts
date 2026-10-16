import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { Reports } from "../src/reports.ts";

const CLI = resolve(import.meta.dirname, "../src/report-cli.ts");

function setUp(): { config: string; reports: Reports; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "fraction-agents-report-cli-"));
  const dir = join(root, "reports");
  const config = join(root, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "deep-researcher",
      description: "Researches.",
      agentDir: join(root, "agent"),
      dataDir: join(root, "data"),
      allowedCallers: ["system:serviceaccount:fraction-agents:owner"],
      publicUrl: "https://agents.example.test/deep-researcher",
      reports: { dir },
    }),
  );
  return { config, reports: new Reports(dir), dir };
}

function run(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, TZ: "Asia/Tokyo", ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function save(reports: Reports, owner: string, title: string, createdAt: number, partial = false): string {
  const id = crypto.randomUUID();
  reports.save({ id, owner, contextId: crypto.randomUUID(), title, createdAt, partial }, "body");
  return id;
}

describe("report command", () => {
  it("lists every caller's reports, newest first", () => {
    const { config, reports } = setUp();
    const old = save(reports, "system:serviceaccount:fraction-agents:claude", "Old one", Date.parse("2026-10-01T00:00:00Z"));
    const recent = save(reports, "system:serviceaccount:fraction-agents:natsumi", "Recent\tone", Date.parse("2026-10-15T00:00:00Z"), true);
    const { status, stdout } = run(["--config", config, "list"]);
    assert.equal(status, 0);
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.startsWith(`${recent}\t2026-10-15`));
    assert.match(lines[0]!, /\tnatsumi\tpartial\tRecent one$/);
    assert.ok(lines[1]!.startsWith(`${old}\t2026-10-01`));
    assert.match(lines[1]!, /\tclaude\t\tOld one$/);
  });

  it("takes the config from the environment as the host does", () => {
    const { config, reports } = setUp();
    save(reports, "system:serviceaccount:fraction-agents:claude", "One", Date.now());
    const { status, stdout } = run(["list"], { FRACTION_AGENTS_CONFIG: config });
    assert.equal(status, 0);
    assert.match(stdout, /One/);
  });

  it("deletes any caller's report", () => {
    const { config, reports } = setUp();
    const id = save(reports, "system:serviceaccount:fraction-agents:claude", "One", Date.now());
    const deleted = run(["--config", config, "delete", id]);
    assert.equal(deleted.status, 0);
    assert.match(deleted.stdout, new RegExp(`deleted ${id}`));
    assert.deepEqual(reports.list(), []);
    const again = run(["--config", config, "delete", id]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /not found/);
  });

  it("says how to use it when the arguments are wrong", () => {
    const { config } = setUp();
    for (const args of [[], ["remove"], ["delete"]]) {
      const result = run(["--config", config, ...args]);
      assert.equal(result.status, 2, args.join(" "));
      assert.match(result.stderr, /usage/i);
    }
  });

  it("says which config it could not read", () => {
    const result = run(["--config", "/nonexistent/config.json", "list"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^\/nonexistent\/config\.json: /);
    assert.doesNotMatch(result.stderr, /at loadConfig/);
  });

  it("refuses a config without reports", () => {
    const { config } = setUp();
    const root = join(config, "..");
    const bare = join(root, "bare.json");
    writeFileSync(
      bare,
      JSON.stringify({
        name: "x",
        description: "x",
        agentDir: "/agent",
        dataDir: "/data",
        allowedCallers: [],
        publicUrl: "https://agents.example.test/x",
      }),
    );
    const result = run(["--config", bare, "list"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /reports/);
  });
});
