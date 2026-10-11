import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig, parseConfig } from "../src/config.ts";

const minimal = {
  name: "wiki-keeper",
  description: "Keeps the wiki.",
  agentDir: "/var/lib/agent",
  dataDir: "/data",
  allowedCallers: ["system:serviceaccount:fraction-agents:owner"],
  publicUrl: "https://agents.example.test/wiki-keeper",
};

describe("config", () => {
  it("fills in the defaults", () => {
    const config = parseConfig(minimal);
    assert.equal(config.name, "wiki-keeper");
    assert.equal(config.port, 8080);
    assert.equal(config.idleTimeoutSeconds, 1800);
    assert.equal(config.sessionRetentionSeconds, 604800);
    assert.deepEqual(config.piCommand, ["pi"]);
    assert.equal(config.workDir, "/data/work");
    assert.equal(config.version, "0.0.0");
    assert.deepEqual(config.skills, []);
    assert.deepEqual(config.passEnv, []);
    assert.equal(config.contextWorkspace, undefined);
    assert.equal(config.inputTimeoutSeconds, 86400);
    assert.equal(config.artifactRetentionSeconds, 604800);
  });

  it("takes the commands that prepare and remove a context's workspace", () => {
    const config = parseConfig({
      ...minimal,
      contextWorkspace: { prepare: ["node", "worktree.ts", "prepare"], remove: ["node", "worktree.ts", "remove"] },
    });
    assert.deepEqual(config.contextWorkspace, {
      prepare: ["node", "worktree.ts", "prepare"],
      remove: ["node", "worktree.ts", "remove"],
    });
    assert.deepEqual(parseConfig({ ...minimal, contextWorkspace: { prepare: ["mkdir", "-p"] } }).contextWorkspace, {
      prepare: ["mkdir", "-p"],
      remove: [],
    });
    assert.throws(() => parseConfig({ ...minimal, contextWorkspace: {} }), /contextWorkspace\.prepare/);
    assert.throws(() => parseConfig({ ...minimal, contextWorkspace: { prepare: [] } }), /contextWorkspace\.prepare/);
    assert.throws(() => parseConfig({ ...minimal, contextWorkspace: ["mkdir"] }), /contextWorkspace/);
  });

  it("takes extra environment variable names to pass to pi", () => {
    assert.deepEqual(parseConfig({ ...minimal, passEnv: ["GIT_AUTHOR_NAME", "http_proxy"] }).passEnv, [
      "GIT_AUTHOR_NAME",
      "http_proxy",
    ]);
    assert.throws(() => parseConfig({ ...minimal, passEnv: ["NOT=A NAME"] }), /passEnv/);
    assert.throws(() => parseConfig({ ...minimal, passEnv: "HOME" }), /passEnv/);
  });

  it("keeps the values it is given", () => {
    const config = parseConfig({
      ...minimal,
      version: "1.2.3",
      port: 9000,
      idleTimeoutSeconds: 60,
      sessionRetentionSeconds: 3600,
      inputTimeoutSeconds: 600,
      artifactRetentionSeconds: 86400,
      workDir: "/work",
      piCommand: ["node", "fake-pi.ts"],
      skills: [{ id: "ingest", name: "Ingest", description: "Ingests a source.", tags: ["wiki"], examples: ["add this"] }],
    });
    assert.equal(config.version, "1.2.3");
    assert.equal(config.port, 9000);
    assert.equal(config.idleTimeoutSeconds, 60);
    assert.equal(config.sessionRetentionSeconds, 3600);
    assert.equal(config.inputTimeoutSeconds, 600);
    assert.equal(config.artifactRetentionSeconds, 86400);
    assert.equal(config.workDir, "/work");
    assert.deepEqual(config.piCommand, ["node", "fake-pi.ts"]);
    assert.deepEqual(config.skills, [
      { id: "ingest", name: "Ingest", description: "Ingests a source.", tags: ["wiki"], examples: ["add this"] },
    ]);
  });

  for (const field of ["name", "description", "agentDir", "dataDir", "publicUrl"] as const) {
    it(`rejects a missing ${field}`, () => {
      const { [field]: _, ...rest } = minimal;
      assert.throws(() => parseConfig(rest), new RegExp(field));
    });
  }

  it("rejects a caller that is not a ServiceAccount name", () => {
    assert.throws(() => parseConfig({ ...minimal, allowedCallers: ["owner"] }), /allowedCallers/);
  });

  it("rejects non-positive durations", () => {
    assert.throws(() => parseConfig({ ...minimal, idleTimeoutSeconds: 0 }), /idleTimeoutSeconds/);
    assert.throws(() => parseConfig({ ...minimal, sessionRetentionSeconds: -1 }), /sessionRetentionSeconds/);
    assert.throws(() => parseConfig({ ...minimal, artifactRetentionSeconds: 0 }), /artifactRetentionSeconds/);
  });

  it("rejects relative directories", () => {
    assert.throws(() => parseConfig({ ...minimal, dataDir: "data" }), /dataDir/);
  });

  it("reads a JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "fraction-agents-config-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(minimal));
    assert.equal(loadConfig(path).name, "wiki-keeper");
  });
});

describe("the agents' examples", () => {
  const agentsDir = join(import.meta.dirname, "..", "agents");
  const agents = readdirSync(agentsDir);

  it("are configs the host accepts, named after their directory", () => {
    assert.ok(agents.includes("news-agent"));
    for (const agent of agents) {
      const config = loadConfig(join(agentsDir, agent, "config.example.json"));
      assert.equal(config.name, agent);
    }
  });

  // The line a scheduled request ends with (ADR 0017): every agent says how it reads it, in its Agent Card and in
  // its AGENTS.md, whether it uses the time or not.
  it("say how they read the line 前回の受け取り", () => {
    for (const agent of agents) {
      const config = loadConfig(join(agentsDir, agent, "config.example.json"));
      assert.match(config.description, /前回の受け取り/, `${agent}'s Agent Card`);
      assert.match(readFileSync(join(agentsDir, agent, "AGENTS.md"), "utf8"), /前回の受け取り/, `${agent}'s AGENTS.md`);
    }
  });
});
