import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The repository settings of the deep researcher (ADR 0022): how much one context may clone, and how long the
 * clone and history tools may take. No secrets: the agent clones public repositories without credentials.
 */
export interface RepositoriesConfig {
  clone: {
    /** The largest one clone may grow to. */
    maxSizeMegabytes: number;
    /** The most all the clones of one context may take together. */
    maxTotalSizeMegabytes: number;
    /** How long one clone may take. */
    timeoutSeconds: number;
  };
  history: {
    /** How long one git log, show or blame may take (a partial clone fetches file contents as they are needed). */
    timeoutSeconds: number;
    /** The longest output shown to the agent; the rest is cut. */
    maxOutputCharacters: number;
  };
}

/** The file name of the settings inside pi's agent directory. */
export const REPOSITORIES_CONFIG_FILE = "repositories.json";

/** Where clones go inside the context's workspace: `repos/<owner>/<repo>`, in lower case. */
export const REPOSITORIES_DIR = "repos";

export function defaultRepositoriesConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const agentDir = env.PI_CODING_AGENT_DIR;
  return agentDir ? join(agentDir, REPOSITORIES_CONFIG_FILE) : undefined;
}

export function loadRepositoriesConfig(path: string): RepositoriesConfig {
  return parseRepositoriesConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function parseRepositoriesConfig(input: unknown): RepositoriesConfig {
  const root = record(input, "config");
  const clone = root.clone === undefined ? {} : record(root.clone, "clone");
  const history = root.history === undefined ? {} : record(root.history, "history");
  const config: RepositoriesConfig = {
    clone: {
      maxSizeMegabytes: positiveInteger(clone.maxSizeMegabytes, 1024, "clone.maxSizeMegabytes"),
      maxTotalSizeMegabytes: positiveInteger(clone.maxTotalSizeMegabytes, 3072, "clone.maxTotalSizeMegabytes"),
      timeoutSeconds: positiveInteger(clone.timeoutSeconds, 300, "clone.timeoutSeconds"),
    },
    history: {
      timeoutSeconds: positiveInteger(history.timeoutSeconds, 120, "history.timeoutSeconds"),
      maxOutputCharacters: positiveInteger(history.maxOutputCharacters, 40000, "history.maxOutputCharacters"),
    },
  };
  if (config.clone.maxTotalSizeMegabytes < config.clone.maxSizeMegabytes) {
    throw new Error("repositories: clone.maxTotalSizeMegabytes must not be less than clone.maxSizeMegabytes");
  }
  return config;
}

// --- Which repositories ---

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const URL_SHAPE = "https://github.com/<owner>/<repo>";

/** The owner and name of a public GitHub repository, from its URL. Only `https://github.com/<owner>/<repo>`. */
export function parseGitHubUrl(input: string): { owner: string; repo: string } {
  const refuse = () => new Error(`only ${URL_SHAPE} can be cloned, got ${JSON.stringify(input)}`);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw refuse();
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) {
    throw refuse();
  }
  const segments = url.pathname.replace(/\/$/, "").split("/").slice(1);
  if (segments.length !== 2) throw refuse();
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/, "");
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") throw refuse();
  return { owner, repo };
}

/** The repository's name as the tools take it (`<owner>/<repo>`), and where its clone is. */
function cloneLocation(workspace: string, owner: string, repo: string): { name: string; dir: string } {
  const name = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  return { name, dir: join(workspace, REPOSITORIES_DIR, name) };
}

/** The clone of a repository the history tools name as `<owner>/<repo>`. Throws if it is not cloned here. */
export function clonedRepository(workspace: string, repository: string): string {
  const [owner, repo, ...rest] = repository.split("/");
  if (rest.length > 0 || !owner || !repo || !OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") {
    throw new Error(`repository must be <owner>/<repo> of a clone, got ${JSON.stringify(repository)}`);
  }
  const { name, dir } = cloneLocation(workspace, owner, repo);
  if (!existsSync(join(dir, ".git"))) throw new Error(`${name} is not cloned in this context. Clone it with clone_repository first.`);
  return dir;
}

// --- Keeping the reading tools in the workspace ---

const UNICODE_SPACES = /[  -   　]/g;

/**
 * Why a path given to pi's read, grep, find or ls must not be read, or undefined when it may. It must stay in the
 * context's workspace after every symlink on the way is resolved. The path is taken the way pi takes it (unicode
 * spaces as spaces, a leading `@` dropped); `~` and `file:` paths, which pi expands, are refused outright.
 */
export function checkWorkspacePath(path: string | undefined, workspace: string): string | undefined {
  let normalized = (path ?? ".").replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized.startsWith("~") || /^file:/i.test(normalized)) {
    return `${JSON.stringify(path)}: give paths relative to this context's workspace (for example ${REPOSITORIES_DIR}/<owner>/<repo>/README.md).`;
  }
  const root = realpathSync(workspace);
  const target = realTarget(resolve(workspace, normalized === "" ? "." : normalized));
  if (target === root || target.startsWith(root + sep)) return undefined;
  return `${JSON.stringify(path)} is outside this context's workspace. Only the repositories cloned here (under ${REPOSITORIES_DIR}/) can be read.`;
}

/** The path with every symlink resolved; the part that does not exist yet is put back as it was. */
function realTarget(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(basename(current));
      current = parent;
    }
  }
}

// --- The history tools' arguments ---

/** One revision: a commit, a branch, a tag, with ~ and ^ after it. Nothing that git could read as an option. */
const REVISION = /^[A-Za-z0-9_][A-Za-z0-9_.\/~^-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;
const LOG_FORMAT = "--format=%H %ad %an%n    %s";

function revision(value: string | undefined, allowRange: boolean): string {
  const rev = value ?? "HEAD";
  const sides = allowRange ? rev.split(/\.{2,3}/) : [rev];
  const ok = sides.length <= 2 && sides.every((side) => REVISION.test(side) && !side.includes("..") && !side.endsWith("."));
  if (!ok) {
    throw new Error(`revision must be a commit, branch or tag (with ~ or ^)${allowRange ? ", or two of them as A..B" : ""}, got ${JSON.stringify(rev)}`);
  }
  return rev;
}

function repoPath(value: string, field = "path"): string {
  const bad =
    value === "" || value.includes("\0") || isAbsolute(value) || value.startsWith("-") || value.split(/[\\/]/).includes("..");
  if (bad) throw new Error(`${field} must be a path relative to the repository, got ${JSON.stringify(value)}`);
  return value;
}

function count(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  return n;
}

function date(value: string, field: string): string {
  if (!DATE.test(value)) throw new Error(`${field} must be a date such as 2026-10-01, got ${JSON.stringify(value)}`);
  return value;
}

function oneLine(value: string, field: string): string {
  if (value === "" || /[\0\n\r]/.test(value)) throw new Error(`${field} must be one line of text`);
  return value;
}

export interface LogParams {
  revision?: string;
  path?: string;
  maxCount?: number;
  skip?: number;
  since?: string;
  until?: string;
  author?: string;
  grep?: string;
  files?: boolean;
}

/** `git log` in one fixed shape. Every value given is one argument of its own, after its option's `=`. */
export function logArgs(params: LogParams): string[] {
  const args = ["log", "--no-color", "--date=iso-strict", LOG_FORMAT, `--max-count=${count(params.maxCount, 30, 1, 200, "maxCount")}`];
  if (params.skip !== undefined) args.push(`--skip=${count(params.skip, 0, 0, 1_000_000, "skip")}`);
  if (params.since !== undefined) args.push(`--since=${date(params.since, "since")}`);
  if (params.until !== undefined) args.push(`--until=${date(params.until, "until")}`);
  if (params.author !== undefined) args.push(`--author=${oneLine(params.author, "author")}`);
  if (params.grep !== undefined) args.push(`--grep=${oneLine(params.grep, "grep")}`);
  if (params.author !== undefined || params.grep !== undefined) args.push("--fixed-strings", "--regexp-ignore-case");
  if (params.files) args.push("--name-status");
  args.push("--end-of-options", revision(params.revision, true), "--");
  if (params.path !== undefined) args.push(repoPath(params.path));
  return args;
}

export interface ShowParams {
  revision: string;
  /** Limits the commit's diff to this path. */
  path?: string;
  /** Shows this file as it was at the revision, instead of the commit. */
  file?: string;
}

/** `git show` of a commit (message, stat and patch), or of one file at a revision. */
export function showArgs(params: ShowParams): string[] {
  const rev = revision(params.revision, false);
  if (params.file !== undefined) return ["show", "--no-color", "--no-textconv", "--end-of-options", `${rev}:${repoPath(params.file, "file")}`];
  const args = ["show", "--no-color", "--no-ext-diff", "--no-textconv", "--date=iso-strict", "--stat", "--patch", "--end-of-options", rev, "--"];
  if (params.path !== undefined) args.push(repoPath(params.path));
  return args;
}

export interface BlameParams {
  path: string;
  revision?: string;
  startLine?: number;
  endLine?: number;
}

/** `git blame` of one file, optionally of some of its lines. */
export function blameArgs(params: BlameParams): string[] {
  const path = repoPath(params.path);
  const rev = revision(params.revision, false);
  const args = ["blame", "--date=short"];
  if (params.startLine !== undefined || params.endLine !== undefined) {
    const start = count(params.startLine, 1, 1, 10_000_000, "startLine");
    const end = params.endLine === undefined ? "" : String(count(params.endLine, start, start, 10_000_000, "endLine (not before startLine)"));
    args.push("-L", `${start},${end}`);
  }
  // blame does not take --end-of-options; the revision cannot start with "-" anyway.
  args.push(rev, "--", path);
  return args;
}

// --- Running git ---

/**
 * What every git command of these tools runs with. No credentials of any kind: no credential helper, no prompt,
 * no system or global config (which could add helpers or rewrite URLs). Only the allowed protocols. No symlinks
 * in the checkout, no hooks, and pathspecs taken literally.
 */
function safeGit(protocols: readonly string[]): { config: string[]; env: NodeJS.ProcessEnv } {
  const settings = [
    "credential.helper=",
    "core.askPass=",
    "core.symlinks=false",
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "protocol.allow=never",
    ...protocols.map((protocol) => `protocol.${protocol}.allow=always`),
    "submodule.recurse=false",
    "fetch.recurseSubmodules=false",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && key !== "SSH_ASKPASS") env[key] = value;
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_PAGER: "cat",
  });
  return { config: settings.flatMap((setting) => ["-c", setting]), env };
}

interface RunResult {
  code: number | null;
  output: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

function run(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  limits: { timeoutMs: number; maxOutput: number; signal?: AbortSignal; watch?: (stop: (reason: string) => void) => () => void },
): Promise<RunResult & { stopped?: string }> {
  return new Promise((done) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let stopped: string | undefined;
    const stop = (reason?: string) => {
      if (reason && stopped === undefined) stopped = reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, limits.timeoutMs);
    const onAbort = () => stop("canceled");
    limits.signal?.addEventListener("abort", onAbort);
    const unwatch = limits.watch?.((reason) => stop(reason));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      output += chunk;
      if (output.length > limits.maxOutput) {
        output = output.slice(0, limits.maxOutput);
        truncated = true;
        stop();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.once("error", (error) => {
      stderr = error.message;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      limits.signal?.removeEventListener("abort", onAbort);
      unwatch?.();
      done({ code, output, stderr: stderr.trim(), truncated, timedOut, stopped });
    });
  });
}

/** The bytes a directory takes, without following symlinks. */
export function directorySize(path: string): number {
  let total = 0;
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return 0;
  }
  for (const entry of entries) total += directorySize(join(path, entry));
  return total;
}

const MB = 1024 * 1024;
const REF = /^[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/;

export interface CloneOptions {
  workspace: string;
  url: string;
  /** A branch or tag. The default branch when not given. */
  ref?: string;
  config: RepositoriesConfig;
  /** Where to fetch from instead of the GitHub URL. For tests. */
  remote?: (owner: string, repo: string) => string;
  /** The protocols git may use. Only https by default. */
  protocols?: readonly string[];
  signal?: AbortSignal;
}

/**
 * Clones a public GitHub repository into `repos/<owner>/<repo>` of the context's workspace, read-only (ADR 0022):
 * without credentials, submodules or LFS, without symlinks, and as a partial clone (history now, file contents
 * when needed). A clone that grows past the limits or takes too long is removed. Returns what to tell the agent.
 */
export async function cloneRepository(options: CloneOptions): Promise<string> {
  const { owner, repo } = parseGitHubUrl(options.url);
  if (options.ref !== undefined && (!REF.test(options.ref) || options.ref.includes("..") || options.ref.endsWith("/") || options.ref.endsWith(".lock"))) {
    throw new Error(`ref must be a branch or tag name, got ${JSON.stringify(options.ref)}`);
  }
  const { name, dir } = cloneLocation(options.workspace, owner, repo);
  const { config: gitConfig, env } = safeGit(options.protocols ?? ["https"]);
  if (existsSync(join(dir, ".git"))) {
    const head = await run(dir, [...gitConfig, "rev-parse", "HEAD"], env, { timeoutMs: 10_000, maxOutput: 100 });
    return `${name} is already cloned in this context at ${relative(options.workspace, dir)} (HEAD ${head.output.trim()}). Read it as it is.`;
  }
  rmSync(dir, { recursive: true, force: true });

  const limits = options.config.clone;
  const used = directorySize(join(options.workspace, REPOSITORIES_DIR));
  const left = limits.maxTotalSizeMegabytes * MB - used;
  if (left <= 0) {
    throw new Error(`this context already holds ${Math.ceil(used / MB)} MB of clones, the total allowed (${limits.maxTotalSizeMegabytes} MB). Work with the clones you have.`);
  }
  const allowed = Math.min(limits.maxSizeMegabytes * MB, left);
  const tooLarge =
    allowed < limits.maxSizeMegabytes * MB
      ? `the clone would take more than the ${limits.maxTotalSizeMegabytes} MB total this context may hold`
      : `the repository is larger than ${limits.maxSizeMegabytes} MB, the most one clone may take`;

  const source = options.remote ? options.remote(owner, repo) : `https://github.com/${owner}/${repo}.git`;
  const args = [
    ...gitConfig,
    "clone",
    "--quiet",
    "--filter=blob:none",
    "--single-branch",
    "--no-recurse-submodules",
    // Kept in the clone's own config, so that later fetches of file contents run the same way.
    "--config", "core.symlinks=false",
    "--config", "credential.helper=",
    "--config", "protocol.allow=never",
    ...(options.protocols ?? ["https"]).flatMap((protocol) => ["--config", `protocol.${protocol}.allow=always`]),
    ...(options.ref ? ["--branch", options.ref] : []),
    "--",
    source,
    dir,
  ];
  const watch = (stop: (reason: string) => void) => {
    const timer = setInterval(() => {
      if (directorySize(dir) > allowed) stop(tooLarge);
    }, 500);
    return () => clearInterval(timer);
  };
  const result = await run(options.workspace, args, env, { timeoutMs: limits.timeoutSeconds * 1000, maxOutput: 10_000, signal: options.signal, watch });
  const fail = (reason: string) => {
    rmSync(dir, { recursive: true, force: true });
    return new Error(`could not clone ${name}: ${reason}. The clone was removed.`);
  };
  if (result.stopped) throw fail(result.stopped);
  if (result.timedOut) throw fail(`it took longer than ${limits.timeoutSeconds} seconds`);
  if (result.code !== 0) {
    throw fail(`${result.stderr.split("\n").at(-1) || `git ended with ${result.code}`} (private or missing repositories cannot be cloned)`);
  }
  const size = directorySize(dir);
  if (size > allowed) throw fail(tooLarge);
  const head = await run(dir, [...gitConfig, "log", "-1", "--format=%H %cd", "--date=iso-strict"], env, { timeoutMs: 10_000, maxOutput: 200 });
  const branch = await run(dir, [...gitConfig, "rev-parse", "--abbrev-ref", "HEAD"], env, { timeoutMs: 10_000, maxOutput: 200 });
  const [sha, when] = head.output.trim().split(" ");
  return [
    `Cloned ${name} into ${relative(options.workspace, dir)} (${Math.ceil(size / MB)} MB).`,
    `Checked out: ${options.ref ?? branch.output.trim()} at commit ${sha} (${when}).`,
    `Read its files with read, grep, find and ls under ${relative(options.workspace, dir)}/, and its history with git_log, git_show and git_blame (repository: "${name}").`,
    `Cite https://github.com/${owner}/${repo}/tree/${sha} as the source.`,
  ].join("\n");
}

/** Runs one of the history tools' git commands in a clone, and returns its output, cut to the limit. */
export async function runHistory(
  workspace: string,
  repository: string,
  args: string[],
  config: RepositoriesConfig,
  options: { protocols?: readonly string[]; signal?: AbortSignal } = {},
): Promise<string> {
  const dir = clonedRepository(workspace, repository);
  const { config: gitConfig, env } = safeGit(options.protocols ?? ["https"]);
  const result = await run(dir, [...gitConfig, "--no-pager", ...args], env, {
    timeoutMs: config.history.timeoutSeconds * 1000,
    maxOutput: config.history.maxOutputCharacters,
    signal: options.signal,
  });
  if (result.truncated) {
    return `${result.output}\n\n[Cut at ${config.history.maxOutputCharacters} characters. Narrow it down: a path, fewer commits, or some lines.]`;
  }
  if (result.timedOut) throw new Error(`git ${args[0]} took longer than ${config.history.timeoutSeconds} seconds. Narrow it down.`);
  if (result.stopped) throw new Error(`git ${args[0]} was ${result.stopped}`);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.split("\n").at(-1) || `exit ${result.code}`}`);
  return result.output.trim() === "" ? "(no output)" : result.output;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`repositories: ${name} must be an object`);
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`repositories: ${name} must be a positive integer`);
  return value;
}
