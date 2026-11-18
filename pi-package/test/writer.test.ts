import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createGitHubWriterExtension } from "../extensions/github-writer.ts";
import type { PiApi, ToolContext, ToolDefinition } from "../lib/pi.ts";
import { WriterClient, pullRequestWorkspace, pushWorkspace, syncMirrors } from "../lib/writer-client.ts";
import { mirrorPath, parseWriterConfig, type WriterConfig, type WriterRepository } from "../lib/writer-config.ts";
import { createWriterServer } from "../lib/writer-server.ts";
import { GitHubWriter, checkRepositoryChanges } from "../lib/writer.ts";
import { FAKE_TOKEN, FakeGitHub, containsInFiles, git, makeFixture, write } from "./fixtures/repo.ts";

const PREFIX = "vuln-responder/";
const BASIC = Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString("base64");

interface Setup {
  dir: string;
  config: WriterConfig;
  wiki: WriterRepository;
  infra: WriterRepository;
  remotes: { wiki: string; infra: string };
  github: { wiki: FakeGitHub; infra: FakeGitHub };
  url: string;
  client: WriterClient;
  logs: string[];
  /** Every response body the sidecar sent, as text. */
  responses: string[];
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

/** A bare repository with one commit on main, standing in for a repository on GitHub. */
function bareRemote(dir: string, name: string, files: Record<string, string>): string {
  const remote = join(dir, `${name}.git`);
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  const seed = join(dir, `${name}-seed`);
  execFileSync("git", ["clone", "--quiet", remote, seed], { stdio: "ignore" });
  for (const [path, content] of Object.entries(files)) write(seed, path, content);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return remote;
}

async function setUp(overrides: Record<string, unknown> = {}, infraOverrides: Record<string, unknown> = {}): Promise<Setup> {
  const wikiFixture = makeFixture();
  const dir = wikiFixture.dir;
  const infraRemote = bareRemote(dir, "infra", { "security/vex/README.md": "vex\n", "apps/a.yaml": "a: 1\n" });
  const config = parseWriterConfig({
    mirrorDir: join(dir, "mirror"),
    app: { appId: "1", installationId: "2", privateKeyFile: join(dir, "no-key.pem") },
    repositories: [
      {
        owner: "example",
        name: "wiki",
        remoteUrl: `file://${wikiFixture.remote}`,
        branchPrefix: PREFIX,
        appendOnlyPaths: ["raw/"],
        readOnlyPaths: ["Permanent-Notes/"],
      },
      {
        owner: "example",
        name: "infra",
        remoteUrl: `file://${infraRemote}`,
        branchPrefix: PREFIX,
        writablePaths: ["security/vex/"],
        ...infraOverrides,
      },
    ],
    ...overrides,
  });
  const [wiki, infra] = config.repositories as [WriterRepository, WriterRepository];
  const github = { wiki: wikiFixture.github, infra: new FakeGitHub(infraRemote) };
  const logs: string[] = [];
  const writer = new GitHubWriter({
    config,
    github: (repository) => (repository.name === "wiki" ? github.wiki : github.infra),
    log: (line) => logs.push(line),
  });
  const responses: string[] = [];
  const server = createWriterServer(writer, { config, log: (line) => logs.push(line) });
  server.on("request", (_req, res) => {
    const end = res.end.bind(res);
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (chunk !== undefined && typeof chunk !== "function") responses.push(String(chunk));
      return end(chunk as never, ...(rest as []));
    }) as typeof res.end;
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    dir,
    config,
    wiki,
    infra,
    remotes: { wiki: wikiFixture.remote, infra: infraRemote },
    github,
    url,
    client: new WriterClient(url),
    logs,
    responses,
  };
}

/** The agent's clone of a repository, from the read-only mirror, on a new branch. */
async function agentClone(setup: Setup, repository: WriterRepository, branch = `${PREFIX}ctx-1`): Promise<string> {
  await setup.client.sync(repository);
  const cwd = join(setup.dir, "agent", repository.name);
  mkdirSync(join(setup.dir, "agent"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", `file://${mirrorPath(setup.config, repository)}`, cwd], { stdio: "ignore" });
  git(cwd, "switch", "-q", "-C", branch);
  return cwd;
}

function commit(cwd: string, files: Record<string, string | null>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(cwd, path));
    else write(cwd, path, content);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function remoteBranch(remote: string, branch: string): string | undefined {
  try {
    return git(remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`);
  } catch {
    return undefined;
  }
}

/** A bundle of the refs, without what the agent's clone got from the mirror. */
function bundle(cwd: string, ...refs: string[]): Buffer<ArrayBuffer> {
  const file = join(mkdtempSync(join(tmpdir(), "writer-test-bundle-")), "b.bundle");
  git(cwd, "bundle", "create", "-q", file, ...refs, "--not", "--remotes=origin");
  return readFileSync(file);
}

async function postBundle(setup: Setup, repository: string, branch: string, body: Buffer<ArrayBuffer>): Promise<{ status: number; error: string }> {
  const response = await fetch(`${setup.url}/repos/${repository}/push?branch=${encodeURIComponent(branch)}`, {
    method: "POST",
    headers: { "content-type": "application/x-git-bundle" },
    body,
  });
  const json = (await response.json()) as { error?: string };
  return { status: response.status, error: json.error ?? "" };
}

describe("github-writer: the mirror", () => {
  it("makes a read-only mirror the agent clones without credentials", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.wiki);
    assert.equal(readFileSync(join(cwd, "wiki/topics/a.md"), "utf8"), "# A\n");
    assert.equal(existsSync(join(mirrorPath(setup.config, setup.wiki), "HEAD")), true);
  });

  it("follows the default branch on GitHub when synced again", async () => {
    const setup = await setUp();
    await setup.client.sync(setup.wiki);
    const seed = join(setup.dir, "seed");
    write(seed, "wiki/topics/new.md", "# New\n");
    git(seed, "add", ".");
    git(seed, "commit", "-q", "-m", "new");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const synced = await setup.client.sync(setup.wiki);
    assert.equal(synced.head, git(seed, "rev-parse", "HEAD"));
    assert.equal(git(mirrorPath(setup.config, setup.wiki), "rev-parse", "refs/heads/main"), synced.head);
  });

  it("syncs every repository when none is named", async () => {
    const setup = await setUp();
    const message = await syncMirrors(setup.config, setup.client);
    assert.match(message, /example\/wiki/);
    assert.match(message, /example\/infra/);
    assert.equal(existsSync(join(mirrorPath(setup.config, setup.infra), "HEAD")), true);
  });
});

describe("github-writer: push", () => {
  it("pushes the agent's branch to GitHub", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.wiki);
    const head = commit(cwd, { "wiki/topics/b.md": "# B\n" }, "add b");
    const message = await pushWorkspace(setup.config, setup.client, cwd);
    assert.match(message, /Pushed vuln-responder\/ctx-1/);
    assert.equal(remoteBranch(setup.remotes.wiki, `${PREFIX}ctx-1`), head);
    assert.equal(remoteBranch(setup.remotes.wiki, "main"), git(setup.remotes.wiki, "rev-parse", "refs/heads/main"));
  });

  it("pushes later commits on top, and says when nothing changed", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.wiki);
    commit(cwd, { "wiki/topics/b.md": "# B\n" }, "add b");
    await pushWorkspace(setup.config, setup.client, cwd);
    const second = commit(cwd, { "wiki/topics/c.md": "# C\n" }, "add c");
    await pushWorkspace(setup.config, setup.client, cwd);
    assert.equal(remoteBranch(setup.remotes.wiki, `${PREFIX}ctx-1`), second);
    assert.match(await pushWorkspace(setup.config, setup.client, cwd), /already up to date/);
  });

  it("refuses to push the default branch", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.wiki, "main");
    const before = remoteBranch(setup.remotes.wiki, "main");
    commit(cwd, { "wiki/topics/b.md": "# B\n" }, "add b");
    await assert.rejects(pushWorkspace(setup.config, setup.client, cwd), /default branch/);
    const raw = await postBundle(setup, "example/wiki", "main", bundle(cwd, "refs/heads/main"));
    assert.equal(raw.status, 403);
    assert.equal(remoteBranch(setup.remotes.wiki, "main"), before);
  });

  it("refuses a branch outside the prefix", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.wiki, "feature/x");
    commit(cwd, { "wiki/topics/b.md": "# B\n" }, "add b");
    await assert.rejects(pushWorkspace(setup.config, setup.client, cwd), /vuln-responder\//);
    const raw = await postBundle(setup, "example/wiki", "feature/x", bundle(cwd, "refs/heads/feature/x"));
    assert.equal(raw.status, 403);
    assert.equal(remoteBranch(setup.remotes.wiki, "feature/x"), undefined);
  });

  it("refuses a repository that is not in the settings", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.wiki);
    commit(cwd, { "wiki/topics/b.md": "# B\n" }, "add b");
    const raw = await postBundle(setup, "example/other", `${PREFIX}ctx-1`, bundle(cwd, `refs/heads/${PREFIX}ctx-1`));
    assert.equal(raw.status, 404);
    assert.match(raw.error, /example\/other/);
    const sync = await fetch(`${setup.url}/repos/example/other/sync`, { method: "POST" });
    assert.equal(sync.status, 404);
  });

  it("refuses a bundle whose branch is not the one asked for, or that holds more than the branch", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.wiki);
    commit(cwd, { "wiki/topics/b.md": "# B\n" }, "add b");
    git(cwd, "tag", "v9");
    const other = await postBundle(setup, "example/wiki", `${PREFIX}ctx-2`, bundle(cwd, `refs/heads/${PREFIX}ctx-1`));
    assert.equal(other.status, 400);
    const tagged = await postBundle(setup, "example/wiki", `${PREFIX}ctx-1`, bundle(cwd, `refs/heads/${PREFIX}ctx-1`, "refs/tags/v9"));
    assert.equal(tagged.status, 400);
    const garbage = await postBundle(setup, "example/wiki", `${PREFIX}ctx-1`, Buffer.from("not a bundle"));
    assert.equal(garbage.status, 400);
    assert.equal(remoteBranch(setup.remotes.wiki, `${PREFIX}ctx-1`), undefined);
    assert.equal(git(setup.remotes.wiki, "tag", "--list"), "");
  });

  it("refuses a bundle larger than the limit", async () => {
    const setup = await setUp({ maxBundleBytes: 1024 });
    const raw = await postBundle(setup, "example/wiki", `${PREFIX}ctx-1`, Buffer.alloc(4096, 1));
    assert.equal(raw.status, 413);
  });

  it("never forces: a branch that moved on GitHub is not overwritten", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.wiki);
    commit(cwd, { "wiki/topics/b.md": "# B\n" }, "add b");
    await pushWorkspace(setup.config, setup.client, cwd);
    git(cwd, "reset", "-q", "--hard", "HEAD~1");
    commit(cwd, { "wiki/topics/c.md": "# C\n" }, "rewrite");
    const pushed = remoteBranch(setup.remotes.wiki, `${PREFIX}ctx-1`);
    await assert.rejects(pushWorkspace(setup.config, setup.client, cwd), /not a fast-forward|rejected/);
    assert.equal(remoteBranch(setup.remotes.wiki, `${PREFIX}ctx-1`), pushed);
  });

  it("refuses changes outside the writable paths", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.infra);
    commit(cwd, { "security/vex/a.openvex.json": "{}\n", "apps/a.yaml": "a: 2\n" }, "vex and more");
    await assert.rejects(pushWorkspace(setup.config, setup.client, cwd), /apps\/a\.yaml/);
    assert.equal(remoteBranch(setup.remotes.infra, `${PREFIX}ctx-1`), undefined);
  });

  it("pushes changes inside the writable paths", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.infra);
    const head = commit(cwd, { "security/vex/a.openvex.json": "{}\n" }, "vex");
    await pushWorkspace(setup.config, setup.client, cwd);
    assert.equal(remoteBranch(setup.remotes.infra, `${PREFIX}ctx-1`), head);
  });

  it("allows only additions under append-only paths, and nothing under read-only paths", async () => {
    const setup = await setUp();
    const changed = await agentClone(setup, setup.wiki, `${PREFIX}changed`);
    commit(changed, { "raw/clips/old.md": "rewritten\n" }, "rewrite a clip");
    await assert.rejects(pushWorkspace(setup.config, setup.client, changed), /raw\/clips\/old\.md/);

    rmSync(changed, { recursive: true, force: true });
    const notes = await agentClone(setup, setup.wiki, `${PREFIX}notes`);
    commit(notes, { "Permanent-Notes/new.md": "new\n" }, "a note");
    await assert.rejects(pushWorkspace(setup.config, setup.client, notes), /Permanent-Notes/);

    rmSync(notes, { recursive: true, force: true });
    const added = await agentClone(setup, setup.wiki, `${PREFIX}added`);
    const head = commit(added, { "raw/clips/new.md": "a new clip\n" }, "a new clip");
    await pushWorkspace(setup.config, setup.client, added);
    assert.equal(remoteBranch(setup.remotes.wiki, `${PREFIX}added`), head);
  });

  it("refuses a branch with uncommitted changes or nothing to push", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.wiki);
    await assert.rejects(pushWorkspace(setup.config, setup.client, cwd), /Nothing to push/);
    write(cwd, "wiki/topics/a.md", "changed\n");
    await assert.rejects(pushWorkspace(setup.config, setup.client, cwd), /uncommitted/);
  });

  it("refuses a workspace whose origin is not a mirror", async () => {
    const setup = await setUp();
    const cwd = join(setup.dir, "elsewhere");
    execFileSync("git", ["clone", "--quiet", setup.remotes.wiki, cwd], { stdio: "ignore" });
    await assert.rejects(pushWorkspace(setup.config, setup.client, cwd), /not a clone of a github-writer mirror/);
  });
});

describe("github-writer: pull requests", () => {
  it("pushes and opens a pull request against the default branch, then updates it", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.infra);
    commit(cwd, { "security/vex/a.openvex.json": "{}\n" }, "vex");
    const opened = await pullRequestWorkspace(setup.config, setup.client, cwd, { title: "VEX for A", body: "Why" });
    assert.match(opened, /Opened pull request #1: https:\/\//);
    assert.deepEqual(
      setup.github.infra.pulls.map(({ title, body, head, base, state }) => ({ title, body, head, base, state })),
      [{ title: "VEX for A", body: "Why", head: `${PREFIX}ctx-1`, base: "main", state: "open" }],
    );

    const head = commit(cwd, { "security/vex/b.openvex.json": "{}\n" }, "more vex");
    const updated = await pullRequestWorkspace(setup.config, setup.client, cwd, { body: "Why, and B" });
    assert.match(updated, /#1/);
    assert.equal(setup.github.infra.pulls.length, 1);
    assert.equal(setup.github.infra.pulls[0]?.body, "Why, and B");
    assert.equal(remoteBranch(setup.remotes.infra, `${PREFIX}ctx-1`), head);
  });

  it("needs a title for a new pull request", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.infra);
    commit(cwd, { "security/vex/a.openvex.json": "{}\n" }, "vex");
    await assert.rejects(pullRequestWorkspace(setup.config, setup.client, cwd, {}), /title/);
    assert.equal(setup.github.infra.pulls.length, 0);
  });

  it("does not open a pull request from a branch it may not push", async () => {
    const setup = await setUp();
    const response = await fetch(`${setup.url}/repos/example/infra/pulls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "main", title: "x" }),
    });
    assert.equal(response.status, 403);
    const outside = await fetch(`${setup.url}/repos/example/infra/pulls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "feature/x", title: "x" }),
    });
    assert.equal(outside.status, 403);
    assert.equal(setup.github.infra.pulls.length, 0);
  });

  it("tells the state of the branch's latest pull request", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.infra);
    commit(cwd, { "security/vex/a.openvex.json": "{}\n" }, "vex");
    assert.equal(await setup.client.latestPullRequest(setup.infra, `${PREFIX}ctx-1`), undefined);
    await pullRequestWorkspace(setup.config, setup.client, cwd, { title: "VEX" });
    setup.github.infra.close(1);
    const latest = await setup.client.latestPullRequest(setup.infra, `${PREFIX}ctx-1`);
    assert.equal(latest?.number, 1);
    assert.equal(latest?.state, "closed");
  });

  it("asks the repository's reviewers to review a new pull request, and not again when it is updated", async () => {
    const setup = await setUp({}, { reviewers: ["octo-cat", "reviewer2"] });
    const cwd = await agentClone(setup, setup.infra);
    commit(cwd, { "security/vex/a.openvex.json": "{}\n" }, "vex");
    await pullRequestWorkspace(setup.config, setup.client, cwd, { title: "VEX for A", body: "Why" });
    assert.deepEqual(setup.github.infra.reviewRequests, [{ number: 1, reviewers: ["octo-cat", "reviewer2"] }]);

    commit(cwd, { "security/vex/b.openvex.json": "{}\n" }, "more vex");
    await pullRequestWorkspace(setup.config, setup.client, cwd, { body: "Why, and B" });
    await pullRequestWorkspace(setup.config, setup.client, cwd, {});
    assert.equal(setup.github.infra.pulls.length, 1);
    assert.equal(setup.github.infra.reviewRequests.length, 1, "an existing pull request is not asked again");
  });

  it("asks nobody when the repository has no reviewers", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.infra);
    commit(cwd, { "security/vex/a.openvex.json": "{}\n" }, "vex");
    await pullRequestWorkspace(setup.config, setup.client, cwd, { title: "VEX" });
    assert.equal(setup.github.infra.pulls.length, 1);
    assert.deepEqual(setup.github.infra.reviewRequests, []);
  });

  it("still opens the pull request when asking for reviewers fails, and logs why", async () => {
    const setup = await setUp({}, { reviewers: ["outsider"] });
    const cwd = await agentClone(setup, setup.infra);
    commit(cwd, { "security/vex/a.openvex.json": "{}\n" }, "vex");
    setup.github.infra.requestReviewers = async () => {
      throw new Error("GitHub POST /repos/example/infra/pulls/1/requested_reviewers failed: HTTP 422 Reviews may only be requested from collaborators.");
    };
    const opened = await pullRequestWorkspace(setup.config, setup.client, cwd, { title: "VEX" });
    assert.match(opened, /Opened pull request #1: https:\/\//);
    assert.equal(setup.github.infra.pulls.length, 1);
    const line = setup.logs.find((entry) => entry.includes("reviewers"));
    assert.ok(line, `a log line about the reviewers in: ${setup.logs.join("\n")}`);
    assert.match(line, /example\/infra#1/);
    assert.match(line, /outsider/);
    assert.match(line, /HTTP 422/);
  });

  it("reports a failure on GitHub as such", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.infra);
    commit(cwd, { "security/vex/a.openvex.json": "{}\n" }, "vex");
    setup.github.infra.createPullRequest = async () => {
      throw new Error("GitHub POST /repos/example/infra/pulls failed: HTTP 422 Validation Failed");
    };
    await assert.rejects(pullRequestWorkspace(setup.config, setup.client, cwd, { title: "VEX" }), /HTTP 422 Validation Failed/);
  });
});

describe("github-writer: what it does not do", () => {
  it("has no way to merge, delete a branch or change the repository", async () => {
    const setup = await setUp();
    for (const [method, path] of [
      ["PUT", "/repos/example/wiki/pulls/1/merge"],
      ["POST", "/repos/example/wiki/pulls/1/merge"],
      ["DELETE", `/repos/example/wiki/branches/${PREFIX}ctx-1`],
      ["DELETE", "/repos/example/wiki"],
      ["PATCH", "/repos/example/wiki"],
      ["POST", "/repos/example/wiki/merges"],
    ] as const) {
      const response = await fetch(`${setup.url}${path}`, { method });
      assert.ok(response.status === 404 || response.status === 405, `${method} ${path} answered ${response.status}`);
    }
  });

  it("never puts the token in a response, a log line or the mirror", async () => {
    const setup = await setUp();
    const cwd = await agentClone(setup, setup.infra);
    commit(cwd, { "security/vex/a.openvex.json": "{}\n" }, "vex");
    await pullRequestWorkspace(setup.config, setup.client, cwd, { title: "VEX" });
    commit(cwd, { "apps/a.yaml": "a: 3\n" }, "outside");
    await assert.rejects(pushWorkspace(setup.config, setup.client, cwd));
    await postBundle(setup, "example/infra", "main", Buffer.from("garbage"));
    assert.ok(setup.github.infra.tokensIssued > 0, "the token was used");
    assert.ok(setup.logs.length > 0, "requests are logged");
    for (const text of [...setup.logs, ...setup.responses]) {
      assert.equal(text.includes(FAKE_TOKEN), false, text);
      assert.equal(text.includes(BASIC), false, text);
    }
    assert.deepEqual(containsInFiles(setup.config.mirrorDir, FAKE_TOKEN), []);
    assert.deepEqual(containsInFiles(setup.config.mirrorDir, BASIC), []);
    assert.deepEqual(containsInFiles(join(setup.dir, "agent"), BASIC), []);
  });
});

class FakePi implements PiApi {
  readonly tools = new Map<string, ToolDefinition>();

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  on(): void {}

  async call(name: string, params: Record<string, unknown>, cwd: string): Promise<string> {
    const tool = this.tools.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    const ctx: ToolContext = { cwd, hasUI: false, ui: { input: async () => undefined } };
    const result = await tool.execute("call-1", params, undefined, undefined, ctx);
    return result.content.map((part) => part.text).join("");
  }
}

function agentDir(setup: Setup, files: Record<string, unknown>): string {
  const dir = join(setup.dir, "agent-dir");
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
  return dir;
}

describe("github-writer extension", () => {
  it("gives the agent the push, pull request and sync tools, which go through the sidecar", async () => {
    const setup = await setUp();
    const dir = agentDir(setup, { "github-writer.json": setup.config });
    const pi = new FakePi();
    createGitHubWriterExtension({ env: { PI_CODING_AGENT_DIR: dir }, client: () => setup.client })(pi);
    assert.deepEqual([...pi.tools.keys()].sort(), ["github_pull_request", "github_pull_request_status", "github_push", "github_sync"]);

    assert.match(await pi.call("github_sync", { repository: "example/infra" }, setup.dir), /example\/infra/);
    const cwd = await agentClone(setup, setup.infra);
    const head = commit(cwd, { "security/vex/a.openvex.json": "{}\n" }, "vex");
    assert.match(await pi.call("github_pull_request", { title: "VEX", body: "Why" }, cwd), /Opened pull request #1/);
    assert.equal(remoteBranch(setup.remotes.infra, `${PREFIX}ctx-1`), head);
    commit(cwd, { "security/vex/b.openvex.json": "{}\n" }, "more");
    assert.match(await pi.call("github_push", { path: "." }, join(cwd, "..")).catch((error: Error) => error.message), /not a clone/);
    assert.match(await pi.call("github_push", {}, cwd), /Pushed/);
  });

  it("tells the state of the pull request of the clone's current branch", async () => {
    const setup = await setUp();
    const dir = agentDir(setup, { "github-writer.json": setup.config });
    const pi = new FakePi();
    createGitHubWriterExtension({ env: { PI_CODING_AGENT_DIR: dir }, client: () => setup.client })(pi);
    const cwd = await agentClone(setup, setup.infra);
    assert.match(await pi.call("github_pull_request_status", {}, cwd), new RegExp(`${PREFIX}ctx-1 has no pull request`));
    commit(cwd, { "security/vex/a.openvex.json": "{}\n" }, "vex");
    await pi.call("github_pull_request", { title: "VEX" }, cwd);
    assert.match(await pi.call("github_pull_request_status", {}, cwd), /#1 .* is open/);
    setup.github.infra.close(1);
    assert.match(await pi.call("github_pull_request_status", { path: "." }, cwd), /#1 .* was closed without merging/);
    setup.github.infra.pulls[0]!.merged = true;
    assert.match(await pi.call("github_pull_request_status", {}, cwd), /#1 .* was merged/);
  });

  it("registers nothing without its settings", () => {
    const pi = new FakePi();
    createGitHubWriterExtension({ env: { PI_CODING_AGENT_DIR: "/nonexistent" } })(pi);
    assert.equal(pi.tools.size, 0);
  });

  it("stays off, with a warning, when the agent also has the GitHub gate", async () => {
    const setup = await setUp();
    const dir = agentDir(setup, { "github-writer.json": setup.config, "github-gate.json": { placeholder: true } });
    const warnings: string[] = [];
    const pi = new FakePi();
    createGitHubWriterExtension({ env: { PI_CODING_AGENT_DIR: dir }, warn: (message) => warnings.push(message) })(pi);
    assert.equal(pi.tools.size, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /github-gate\.json/);
  });

  it("stays off, with a warning, when its settings are not usable", async () => {
    const setup = await setUp();
    const dir = agentDir(setup, { "github-writer.json": { repositories: [] } });
    const warnings: string[] = [];
    const pi = new FakePi();
    createGitHubWriterExtension({ env: { PI_CODING_AGENT_DIR: dir }, warn: (message) => warnings.push(message) })(pi);
    assert.equal(pi.tools.size, 0);
    assert.match(warnings[0] ?? "", /github-writer\.json/);
  });
});

describe("github-writer: without the App's key", () => {
  it("says that no token could be had", async () => {
    const setup = await setUp();
    setup.github.wiki.gitAuthorization = async () => {
      throw new Error("ENOENT: no such file or directory, open '/var/run/secrets/github-app/private-key.pem'");
    };
    const response = await fetch(`${setup.url}/repos/example/wiki/sync`, { method: "POST" });
    assert.equal(response.status, 502);
    assert.match(((await response.json()) as { error: string }).error, /No GitHub token for example\/wiki: ENOENT/);
  });
});

// The settings vuln-responder starts with (ADR 0028): it may write VEX documents to fleet-infra and nothing else.
describe("vuln-responder's github-writer settings", () => {
  const config: WriterConfig = parseWriterConfig(
    JSON.parse(readFileSync(new URL("../../agents/vuln-responder/github-writer.example.json", import.meta.url), "utf8")),
  );
  const repository = (name: string) => {
    const found = config.repositories.find((r) => r.owner === "yuanying" && r.name === name);
    assert.ok(found, `yuanying/${name} is in the example`);
    return found;
  };
  const allows = (name: string, path: string, status = "M") => checkRepositoryChanges([{ status, path }], repository(name)).length === 0;
  const SOURCES = [
    "hshelf",
    "tumblr-like",
    "live",
    "docker-nfs-server",
    "docker-sshd",
    "node-exporter-smartmon",
    "natsumi-sshd",
    "cnidaria-cni",
    "gated",
    "vuln-tracker",
    "fraction-agents",
    "penelope",
    "llm-proxy",
    "release-lag",
  ];

  it("lists the 17 repositories vuln-responder may write to, each on branches starting with vuln-responder/", () => {
    assert.deepEqual(
      config.repositories.map((r) => r.name).sort(),
      [...SOURCES, "llm-wiki", "fleet-infra", "k8s-manifests-fraction"].sort(),
    );
    for (const r of config.repositories) {
      assert.equal(r.owner, "yuanying");
      assert.equal(r.branchPrefix, "vuln-responder/");
    }
    // The mirrors are made in this order when the sidecar starts: fleet-infra, which every context needs, first.
    assert.equal(config.repositories[0]?.name, "fleet-infra");
    assert.deepEqual(config.app, { appId: "5493557", installationId: "175776468", privateKeyFile: "/var/run/secrets/github-app/private-key.pem" });
    assert.equal(config.mirrorDir, "/var/run/github-writer/mirror");
    assert.equal(config.workspace?.cloneDir, "/data/repos");
  });

  it("names each repository's default branch", () => {
    const master = ["tumblr-like", "docker-sshd", "node-exporter-smartmon", "k8s-manifests-fraction"];
    for (const r of config.repositories) assert.equal(r.defaultBranch, master.includes(r.name) ? "master" : "main", r.name);
  });

  it("lets the sources be fixed anywhere but .github/", () => {
    for (const name of SOURCES) {
      assert.ok(allows(name, "Gemfile.lock"), name);
      assert.ok(allows(name, "Dockerfile"), name);
      assert.ok(allows(name, "go.sum"), name);
      assert.ok(!allows(name, ".github/workflows/release.yaml"), name);
      assert.ok(!allows(name, ".github/renovate.json", "A"), name);
    }
  });

  it("lets llm-wiki be fixed under web/ only", () => {
    assert.ok(allows("llm-wiki", "web/package-lock.json"));
    assert.ok(allows("llm-wiki", "web/Dockerfile"));
    assert.ok(!allows("llm-wiki", "wiki/index.md"));
    assert.ok(!allows("llm-wiki", "README.md"));
    assert.ok(!allows("llm-wiki", ".github/workflows/web.yaml"));
  });

  it("lets fleet-infra take versions in apps/ and infrastructure/ and annotations in security/vex/, nothing else", () => {
    assert.ok(allows("fleet-infra", "apps/aphrael/base/kustomization.yaml"));
    assert.ok(allows("fleet-infra", "infrastructure/longhorn/base/src/values.yaml"));
    assert.ok(allows("fleet-infra", "security/vex/ghcr.io/yuanying/hshelf.openvex.json", "A"));
    assert.ok(!allows("fleet-infra", "secrets/prod/kube-prometheus.enc.yaml"));
    assert.ok(!allows("fleet-infra", "scripts/update-gated.sh"));
    assert.ok(!allows("fleet-infra", "renovate.json"));
    assert.ok(!allows("fleet-infra", ".github/workflows/ci.yaml"));
  });

  it("lets k8s-manifests-fraction take cnidaria's version only", () => {
    assert.ok(allows("k8s-manifests-fraction", "porkadot.yaml"));
    assert.ok(allows("k8s-manifests-fraction", "assets/kubernetes/manifests/addons/cnidaria/cnidaria.yaml"));
    assert.ok(!allows("k8s-manifests-fraction", "assets/kubernetes/manifests/addons/cnidaria-other/x.yaml"));
    assert.ok(!allows("k8s-manifests-fraction", "assets/certs/kubernetes/ca.key"));
    assert.ok(!allows("k8s-manifests-fraction", "assets/kubernetes/manifests/crds/cnidaria/crds.yaml"));
  });

  it("prepares a worktree of fleet-infra only, and commits as the App's bot, whose commits the releases on merge count", () => {
    assert.deepEqual(config.workspace?.repositories, ["yuanying/fleet-infra"]);
    assert.deepEqual(config.workspace?.commitIdentity, {
      name: "fraction-vuln-responder[bot]",
      email: "348762456+fraction-vuln-responder[bot]@users.noreply.github.com",
    });
  });
});
