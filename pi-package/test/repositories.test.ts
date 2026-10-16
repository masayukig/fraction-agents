import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createRepositories } from "../extensions/repositories.ts";
import type { PiApi, ToolContext, ToolDefinition } from "../lib/pi.ts";
import {
  blameArgs,
  checkWorkspacePath,
  cloneRepository,
  logArgs,
  parseGitHubUrl,
  parseRepositoriesConfig,
  showArgs,
  type RepositoriesConfig,
} from "../lib/repositories.ts";
import { git, write } from "./fixtures/repo.ts";

class FakePi implements PiApi {
  readonly tools = new Map<string, ToolDefinition>();
  readonly handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  readonly cwd: string;
  constructor(cwd: string) {
    this.cwd = cwd;
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  on(event: string, handler: (event: any, ctx: any) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  context(): ToolContext {
    return { cwd: this.cwd, hasUI: false, ui: { input: async () => undefined } };
  }

  async toolCall(toolName: string, input: Record<string, unknown>): Promise<{ block: true; reason: string } | undefined> {
    for (const handler of this.handlers.get("tool_call") ?? []) {
      const result = (await handler({ toolName, toolCallId: "call-1", input }, this.context())) as { block: true; reason: string } | undefined;
      if (result) return result;
    }
    return undefined;
  }

  async call(name: string, params: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    const result = await tool.execute("call-1", params, undefined, undefined, this.context());
    return result.content.map((part) => part.text).join("");
  }
}

const LIMITS: RepositoriesConfig = parseRepositoriesConfig({});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fraction-agents-repositories-"));
}

/** The path of a bare repository standing in for https://github.com/<owner>/<repo>, with a symlink, a submodule entry and some history. */
function makeRemote(): string {
  const dir = tempDir();
  const work = join(dir, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  write(work, "README.md", "# Example\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "First commit");
  write(work, "src/a.ts", "export const a = 1;\nexport const b = 2;\n");
  symlinkSync("/etc/passwd", join(work, "passwd-link"));
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "Add a and a link");
  git(work, "tag", "v1.0.0");
  const remote = join(dir, "remote.git");
  git(dir, "clone", "-q", "--bare", work, remote);
  // GitHub serves partial clones; a local bare repository has to be told to.
  git(remote, "config", "uploadpack.allowFilter", "true");
  return remote;
}

describe("parseGitHubUrl", () => {
  it("takes https://github.com/<owner>/<repo>", () => {
    assert.deepEqual(parseGitHubUrl("https://github.com/example/tool"), { owner: "example", repo: "tool" });
    assert.deepEqual(parseGitHubUrl("https://github.com/example/tool.git"), { owner: "example", repo: "tool" });
    assert.deepEqual(parseGitHubUrl("https://github.com/Example-Org/my.repo_1/"), { owner: "Example-Org", repo: "my.repo_1" });
  });

  it("refuses every other shape", () => {
    for (const url of [
      "http://github.com/example/tool",
      "ssh://git@github.com/example/tool",
      "git@github.com:example/tool.git",
      "https://gitlab.com/example/tool",
      "https://www.github.com/example/tool",
      "https://github.com.example.test/example/tool",
      "https://user:token@github.com/example/tool",
      "https://github.com:8443/example/tool",
      "https://github.com/example",
      "https://github.com/example/tool/tree/main",
      "https://github.com/example/tool?x=1",
      "https://github.com/example/tool#readme",
      "https://github.com/-example/tool",
      "https://github.com/example/..",
      "https://github.com/example/.git",
      "https://github.com/example/to%2Fol",
      "file:///etc",
      "not a url",
    ]) {
      assert.throws(() => parseGitHubUrl(url), /https:\/\/github\.com\/<owner>\/<repo>/, url);
    }
  });
});

describe("parseRepositoriesConfig", () => {
  it("has defaults for every limit", () => {
    assert.deepEqual(parseRepositoriesConfig({}), {
      clone: { maxSizeMegabytes: 1024, maxTotalSizeMegabytes: 3072, timeoutSeconds: 300 },
      history: { timeoutSeconds: 120, maxOutputCharacters: 40000 },
    });
  });

  it("takes the limits it is given and refuses bad ones", () => {
    const config = parseRepositoriesConfig({ clone: { maxSizeMegabytes: 10, maxTotalSizeMegabytes: 20, timeoutSeconds: 5 }, history: { timeoutSeconds: 3, maxOutputCharacters: 100 } });
    assert.equal(config.clone.maxSizeMegabytes, 10);
    assert.equal(config.history.maxOutputCharacters, 100);
    assert.throws(() => parseRepositoriesConfig([]), /must be an object/);
    assert.throws(() => parseRepositoriesConfig({ clone: { maxSizeMegabytes: 0 } }), /clone.maxSizeMegabytes/);
    assert.throws(() => parseRepositoriesConfig({ clone: { timeoutSeconds: "60" } }), /clone.timeoutSeconds/);
    assert.throws(() => parseRepositoriesConfig({ clone: { maxSizeMegabytes: 20, maxTotalSizeMegabytes: 10 } }), /maxTotalSizeMegabytes/);
  });
});

describe("checkWorkspacePath", () => {
  const workspace = tempDir();
  mkdirSync(join(workspace, "repos", "example", "tool", "src"), { recursive: true });
  writeFileSync(join(workspace, "repos", "example", "tool", "src", "a.ts"), "x");
  const outside = tempDir();
  writeFileSync(join(outside, "secret"), "x");
  symlinkSync(join(outside, "secret"), join(workspace, "repos", "secret-link"));
  symlinkSync(outside, join(workspace, "repos", "outside-dir"));

  it("lets paths inside the workspace through", () => {
    for (const path of [undefined, ".", "repos", "repos/example/tool/src/a.ts", join(workspace, "repos/example/tool"), "repos/example/tool/src/missing.ts", "@repos/example", "repos/example/../example/tool"]) {
      assert.equal(checkWorkspacePath(path, workspace), undefined, String(path));
    }
  });

  it("stops paths that leave the workspace, also through symlinks", () => {
    for (const path of ["..", "../x", "/etc/passwd", "/agent/auth.json", outside, "repos/../../x", "@/etc/passwd", "repos/secret-link", "repos/outside-dir", "repos/outside-dir/secret", "repos/outside-dir/missing"]) {
      assert.match(checkWorkspacePath(path, workspace) ?? "", /outside/, path);
    }
  });

  it("stops ~ and file: paths, which pi expands", () => {
    for (const path of ["~", "~/.pi/agent/auth.json", "file:///etc/passwd"]) {
      assert.match(checkWorkspacePath(path, workspace) ?? "", /relative/, path);
    }
  });
});

describe("the history tools' arguments", () => {
  it("are git log, show and blame in fixed shapes", () => {
    assert.deepEqual(logArgs({}), ["log", "--no-color", "--date=iso-strict", "--format=%H %ad %an%n    %s", "--max-count=30", "--end-of-options", "HEAD", "--"]);
    assert.deepEqual(
      logArgs({ revision: "v1.0.0..main", path: "src/a.ts", maxCount: 5, skip: 10, since: "2026-01-01", until: "2026-06-30", author: "Owner", grep: "fix", files: true }),
      [
        "log", "--no-color", "--date=iso-strict", "--format=%H %ad %an%n    %s", "--max-count=5", "--skip=10",
        "--since=2026-01-01", "--until=2026-06-30", "--author=Owner", "--grep=fix", "--fixed-strings", "--regexp-ignore-case", "--name-status",
        "--end-of-options", "v1.0.0..main", "--", "src/a.ts",
      ],
    );
    assert.deepEqual(showArgs({ revision: "abc123" }), ["show", "--no-color", "--no-ext-diff", "--no-textconv", "--date=iso-strict", "--stat", "--patch", "--end-of-options", "abc123", "--"]);
    assert.deepEqual(showArgs({ revision: "HEAD~2", path: "src" }), ["show", "--no-color", "--no-ext-diff", "--no-textconv", "--date=iso-strict", "--stat", "--patch", "--end-of-options", "HEAD~2", "--", "src"]);
    assert.deepEqual(showArgs({ revision: "v1.0.0", file: "src/a.ts" }), ["show", "--no-color", "--no-textconv", "--end-of-options", "v1.0.0:src/a.ts"]);
    assert.deepEqual(blameArgs({ path: "src/a.ts" }), ["blame", "--date=short", "HEAD", "--", "src/a.ts"]);
    assert.deepEqual(blameArgs({ path: "src/a.ts", revision: "main^", startLine: 10, endLine: 20 }), ["blame", "--date=short", "-L", "10,20", "main^", "--", "src/a.ts"]);
  });

  it("refuse anything that could become an option or leave the repository", () => {
    for (const revision of ["-c", "--output=/tmp/x", "--ext-diff", "HEAD --all", "a;b", "", "$(id)", "HEAD:src", "a..b..c"]) {
      assert.throws(() => logArgs({ revision }), /revision/, revision);
    }
    assert.throws(() => showArgs({ revision: "a..b" }), /revision/);
    assert.throws(() => blameArgs({ path: "a", revision: "a...b" }), /revision/);
    for (const path of ["/etc/passwd", "../x", "src/../../x", "", "a\0b"]) {
      assert.throws(() => logArgs({ path }), /path/, JSON.stringify(path));
      assert.throws(() => blameArgs({ path }), /path/, JSON.stringify(path));
    }
    assert.throws(() => logArgs({ maxCount: 0 }), /maxCount/);
    assert.throws(() => logArgs({ maxCount: 1000 }), /maxCount/);
    assert.throws(() => logArgs({ since: "--all" }), /since/);
    assert.throws(() => blameArgs({ path: "a", startLine: 5, endLine: 2 }), /endLine/);
  });
});

describe("cloneRepository", () => {
  it("clones read-only: no credentials, no symlinks, a partial clone", async () => {
    const remote = makeRemote();
    const workspace = tempDir();
    const message = await cloneRepository({ workspace, url: "https://github.com/Example/Tool", config: LIMITS, remote: () => `file://${remote}`, protocols: ["file"] });
    const dir = join(workspace, "repos", "example", "tool");
    assert.match(message, /repos\/example\/tool/);
    assert.match(message, new RegExp(git(dir, "rev-parse", "HEAD")));
    assert.equal(readFileSync(join(dir, "src", "a.ts"), "utf8"), "export const a = 1;\nexport const b = 2;\n");
    // The link is a plain file holding its target.
    assert.equal(lstatSync(join(dir, "passwd-link")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(dir, "passwd-link"), "utf8"), "/etc/passwd");
    assert.equal(git(dir, "config", "--local", "core.symlinks"), "false");
    assert.equal(git(dir, "config", "--local", "--get-all", "credential.helper"), "");
    assert.equal(git(dir, "config", "--local", "remote.origin.partialclonefilter"), "blob:none");

    const again = await cloneRepository({ workspace, url: "https://github.com/example/tool", config: LIMITS, remote: () => `file://${remote}`, protocols: ["file"] });
    assert.match(again, /already cloned/);
  });

  it("clones a branch or tag when asked", async () => {
    const remote = makeRemote();
    const workspace = tempDir();
    const message = await cloneRepository({ workspace, url: "https://github.com/example/tool", ref: "v1.0.0", config: LIMITS, remote: () => `file://${remote}`, protocols: ["file"] });
    assert.match(message, /v1\.0\.0/);
    await assert.rejects(cloneRepository({ workspace: tempDir(), url: "https://github.com/example/tool", ref: "--upload-pack=x", config: LIMITS, remote: () => `file://${remote}`, protocols: ["file"] }), /ref/);
  });

  it("only fetches over the protocols it allows", async () => {
    const remote = makeRemote();
    const workspace = tempDir();
    await assert.rejects(cloneRepository({ workspace, url: "https://github.com/example/tool", config: LIMITS, remote: () => `file://${remote}` }), /could not clone/);
    assert.equal(existsSync(join(workspace, "repos", "example", "tool")), false);
  });

  it("removes a clone that grows past the limit, and keeps to the total of the context", async () => {
    const remote = makeRemote();
    const workspace = tempDir();
    const tiny = parseRepositoriesConfig({ clone: { maxSizeMegabytes: 1, maxTotalSizeMegabytes: 1 } });
    // Fill the context's share with something that is not a clone.
    mkdirSync(join(workspace, "repos", "other", "big"), { recursive: true });
    writeFileSync(join(workspace, "repos", "other", "big", "blob"), Buffer.alloc(1024 * 1024));
    await assert.rejects(cloneRepository({ workspace, url: "https://github.com/example/tool", config: tiny, remote: () => `file://${remote}`, protocols: ["file"] }), /total/);
    assert.equal(existsSync(join(workspace, "repos", "example", "tool")), false);

    const big = makeRemote();
    const work = join(big, "..", "work");
    writeFileSync(join(work, "big.bin"), Buffer.from(Array.from({ length: 2 * 1024 * 1024 }, (_, i) => (i * 7919) % 251)));
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "big");
    git(work, "push", "-q", big, "main");
    const fresh = tempDir();
    await assert.rejects(cloneRepository({ workspace: fresh, url: "https://github.com/example/tool", config: tiny, remote: () => `file://${big}`, protocols: ["file"] }), /larger than 1 MB/);
    assert.equal(existsSync(join(fresh, "repos", "example", "tool")), false);
  });
});

describe("the repositories extension", () => {
  function agentDir(content?: string): string {
    const dir = tempDir();
    if (content !== undefined) writeFileSync(join(dir, "repositories.json"), content);
    return dir;
  }

  it("does nothing without its settings", async () => {
    const pi = new FakePi(tempDir());
    createRepositories({ env: { PI_CODING_AGENT_DIR: agentDir() } })(pi);
    assert.equal(pi.tools.size, 0);
    assert.equal(await pi.toolCall("read", { path: "/etc/passwd" }), undefined);
  });

  it("adds the clone and history tools and keeps the reading tools in the workspace", async () => {
    const remote = makeRemote();
    const workspace = tempDir();
    const pi = new FakePi(workspace);
    createRepositories({ env: { PI_CODING_AGENT_DIR: agentDir("{}") }, remote: () => `file://${remote}`, protocols: ["file"] })(pi);
    assert.deepEqual([...pi.tools.keys()].sort(), ["clone_repository", "git_blame", "git_log", "git_show"]);

    assert.match(await pi.call("clone_repository", { url: "https://github.com/example/tool" }), /repos\/example\/tool/);
    const log = await pi.call("git_log", { repository: "example/tool" });
    assert.match(log, /Add a and a link/);
    assert.match(log, /First commit/);
    assert.match(await pi.call("git_show", { repository: "example/tool", revision: "HEAD", path: "src" }), /\+export const a = 1;/);
    assert.match(await pi.call("git_show", { repository: "example/tool", revision: "HEAD~1", file: "README.md" }), /# Example/);
    assert.match(await pi.call("git_blame", { repository: "example/tool", path: "src/a.ts", startLine: 2, endLine: 2 }), /export const b = 2;/);
    await assert.rejects(pi.call("git_log", { repository: "example/missing" }), /not cloned/);
    await assert.rejects(pi.call("git_log", { repository: "../x" }), /repository/);

    assert.equal(await pi.toolCall("read", { path: "repos/example/tool/README.md" }), undefined);
    assert.equal(await pi.toolCall("grep", { pattern: "a" }), undefined);
    assert.equal(await pi.toolCall("find", { pattern: "*.ts", path: "repos" }), undefined);
    assert.equal(await pi.toolCall("ls", {}), undefined);
    assert.match((await pi.toolCall("read", { path: "/etc/passwd" }))?.reason ?? "", /outside/);
    assert.match((await pi.toolCall("grep", { pattern: "token", path: "/var/run/secrets" }))?.reason ?? "", /outside/);
    assert.match((await pi.toolCall("ls", { path: ".." }))?.reason ?? "", /outside/);
    assert.match((await pi.toolCall("find", { pattern: "*", path: "~" }))?.reason ?? "", /relative/);
    for (const tool of ["bash", "edit", "write"]) {
      assert.match((await pi.toolCall(tool, { command: "ls", path: "x" }))?.reason ?? "", /not available/, tool);
    }
  });

  it("keeps the guards on when its settings are bad, without the tools", async () => {
    const warnings: string[] = [];
    const pi = new FakePi(tempDir());
    createRepositories({ env: { PI_CODING_AGENT_DIR: agentDir("{ not json") }, warn: (line) => warnings.push(line) })(pi);
    assert.equal(pi.tools.size, 0);
    assert.match(warnings.join("\n"), /repositories\.json is not usable/);
    assert.match((await pi.toolCall("read", { path: "/etc/passwd" }))?.reason ?? "", /outside/);
    assert.match((await pi.toolCall("bash", { command: "ls" }))?.reason ?? "", /not available/);
  });
});
