import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
}

/**
 * Commands that give each context a working directory of its own (for example a git worktree). The context's
 * directory is appended as the last argument; the commands run with the same environment as pi.
 */
export interface ContextWorkspaceConfig {
  /** Run before pi starts for a context. Must leave the directory in place, ready for pi to run in. */
  prepare: string[];
  /** Run when the context is deleted, before the host deletes what is left of the directory. May be empty. */
  remove: string[];
}

/** The pages people read reports on (ADR 0021): a listener of their own, behind gated. */
export interface ReportsWebConfig {
  /** The port of the listener. Not the A2A one. */
  port: number;
  /** The URL people open the pages at. The reply's link and the audience of gated's assertions come from it. */
  publicUrl: string;
  gated: {
    /** The issuer of the assertions accepted: the origin of gated's central authentication host. */
    issuer: string;
    /** Where gated publishes the keys of its assertions. Never taken from an assertion. */
    jwksUrl: string;
  };
  /** The subjects allowed to read, e.g. `github:<login>`. */
  allowedSubjects: string[];
}

/** Replies the host keeps as reports (ADR 0020). */
export interface ReportsConfig {
  /** Where the reports are kept: a directory of their own, so that it alone can be backed up. */
  dir: string;
  /** When set, the pages for people are served (ADR 0021). */
  web?: ReportsWebConfig;
}

/** The one configuration file of a generic host. It holds no secrets. */
export interface Config {
  /** Name, description, version and skills shown in the Agent Card. */
  name: string;
  description: string;
  version: string;
  skills: SkillConfig[];
  /** The URL callers reach this agent at, advertised in the Agent Card. */
  publicUrl: string;
  port: number;
  /** ServiceAccounts allowed to call, as `system:serviceaccount:<namespace>:<name>`. */
  allowedCallers: string[];
  /** Pi's agent directory (`PI_CODING_AGENT_DIR`): AGENTS.md, settings.json, auth.json. */
  agentDir: string;
  /** Where the host keeps its state: the task database and the session files. */
  dataDir: string;
  /** The working directory pi runs in. Defaults to `<dataDir>/work`. */
  workDir: string;
  /** How long an unused pi process lives before it is stopped. */
  idleTimeoutSeconds: number;
  /** How long an unused context's session file is kept before it is deleted. */
  sessionRetentionSeconds: number;
  /** How long a task waits for the caller's answer to the agent's question before it fails. */
  inputTimeoutSeconds: number;
  /** How long an image returned as an artifact is served before it is deleted. */
  artifactRetentionSeconds: number;
  /** The command that starts pi. `--mode rpc --session <file>` is appended. */
  piCommand: string[];
  /**
   * Names of further environment variables to pass from the host to pi, on top of the minimal set. Only names:
   * the values come from the host's environment.
   */
  passEnv: string[];
  /**
   * When set, each context runs pi in `<workDir>/<contextId>`, prepared and removed by these commands. When not,
   * every context runs pi in `workDir` itself.
   */
  contextWorkspace?: ContextWorkspaceConfig;
  /**
   * How long a task may work, not counting the time it waits for its turn or for the caller's answer. When it is
   * reached, the agent is told to wrap up (ADR 0019). No limit when not set.
   */
  taskTimeLimitSeconds?: number;
  /** How long the agent has to wrap up once told, before the host stops the prompt. */
  taskTimeLimitGraceSeconds: number;
  /** How many tasks may work at once in the whole agent. Further tasks wait for their turn. No limit when not set. */
  maxConcurrentTasks?: number;
  /** When set, completed tasks' replies are kept as reports (ADR 0020). */
  reports?: ReportsConfig;
}

const SERVICE_ACCOUNT = /^system:serviceaccount:[^:]+:[^:]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function loadConfig(path: string): Config {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function parseConfig(input: unknown): Config {
  if (!isRecord(input)) throw new Error("config: expected a JSON object");
  const dataDir = absolutePath(input, "dataDir");
  const listenPort = input.port === undefined ? 8080 : port(input.port);
  return {
    name: text(input, "name"),
    description: text(input, "description"),
    version: input.version === undefined ? "0.0.0" : text(input, "version"),
    skills: skills(input.skills),
    publicUrl: url(input, "publicUrl"),
    port: listenPort,
    allowedCallers: callers(input.allowedCallers),
    agentDir: absolutePath(input, "agentDir"),
    dataDir,
    workDir: input.workDir === undefined ? join(dataDir, "work") : absolutePath(input, "workDir"),
    idleTimeoutSeconds: input.idleTimeoutSeconds === undefined ? 1800 : duration(input, "idleTimeoutSeconds"),
    sessionRetentionSeconds:
      input.sessionRetentionSeconds === undefined ? 604800 : duration(input, "sessionRetentionSeconds"),
    inputTimeoutSeconds: input.inputTimeoutSeconds === undefined ? 86400 : duration(input, "inputTimeoutSeconds"),
    artifactRetentionSeconds:
      input.artifactRetentionSeconds === undefined ? 604800 : duration(input, "artifactRetentionSeconds"),
    piCommand: input.piCommand === undefined ? ["pi"] : command(input.piCommand),
    passEnv: input.passEnv === undefined ? [] : envNames(input.passEnv),
    ...(input.contextWorkspace === undefined ? {} : { contextWorkspace: contextWorkspace(input.contextWorkspace) }),
    ...(input.taskTimeLimitSeconds === undefined ? {} : { taskTimeLimitSeconds: duration(input, "taskTimeLimitSeconds") }),
    taskTimeLimitGraceSeconds:
      input.taskTimeLimitGraceSeconds === undefined ? 300 : duration(input, "taskTimeLimitGraceSeconds"),
    ...(input.maxConcurrentTasks === undefined ? {} : { maxConcurrentTasks: count(input.maxConcurrentTasks, "maxConcurrentTasks") }),
    ...(input.reports === undefined ? {} : { reports: reports(input.reports, dataDir, listenPort) }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `name` is the field as the error message calls it, when it is nested. */
function text(input: Record<string, unknown>, field: string, name = field): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`config: ${name} must be a non-empty string`);
  return value;
}

function absolutePath(input: Record<string, unknown>, field: string, name = field): string {
  const value = text(input, field, name);
  if (!isAbsolute(value)) throw new Error(`config: ${name} must be an absolute path`);
  return value;
}

function url(input: Record<string, unknown>, field: string, name = field): string {
  const value = text(input, field, name);
  if (!URL.canParse(value)) throw new Error(`config: ${name} must be a URL`);
  return value;
}

function port(value: unknown, field = "port"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`config: ${field} must be an integer between 1 and 65535`);
  }
  return value;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`config: ${field} must be a positive integer`);
  }
  return value;
}

function reports(value: unknown, dataDir: string, listenPort: number): ReportsConfig {
  if (!isRecord(value)) throw new Error("config: reports must be an object");
  return {
    dir: value.dir === undefined ? join(dataDir, "reports") : absolutePath(value, "dir", "reports.dir"),
    ...(value.web === undefined ? {} : { web: reportsWeb(value.web, listenPort) }),
  };
}

function reportsWeb(value: unknown, listenPort: number): ReportsWebConfig {
  if (!isRecord(value)) throw new Error("config: reports.web must be an object");
  if (value.port === undefined) throw new Error("config: reports.web.port is required");
  const webPort = port(value.port, "reports.web.port");
  if (webPort === listenPort) throw new Error("config: reports.web.port must not be the A2A port");
  if (!isRecord(value.gated)) throw new Error("config: reports.web.gated must be an object");
  const issuer = url(value.gated, "issuer", "reports.web.gated.issuer");
  if (new URL(issuer).origin !== issuer) throw new Error("config: reports.web.gated.issuer must be an origin, such as https://auth.example.com");
  if (value.allowedSubjects === undefined) throw new Error("config: reports.web.allowedSubjects is required");
  const allowedSubjects = stringList(value.allowedSubjects, "reports.web.allowedSubjects");
  if (allowedSubjects.length === 0) throw new Error("config: reports.web.allowedSubjects must not be empty");
  return {
    port: webPort,
    publicUrl: url(value, "publicUrl", "reports.web.publicUrl"),
    gated: { issuer, jwksUrl: url(value.gated, "jwksUrl", "reports.web.gated.jwksUrl") },
    allowedSubjects,
  };
}

function duration(input: Record<string, unknown>, field: string): number {
  const value = input[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`config: ${field} must be a positive number of seconds`);
  }
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`config: ${field} must be a list of non-empty strings`);
  }
  return value as string[];
}

function callers(value: unknown): string[] {
  const list = stringList(value, "allowedCallers");
  const bad = list.find((caller) => !SERVICE_ACCOUNT.test(caller));
  if (bad !== undefined) {
    throw new Error(`config: allowedCallers must be system:serviceaccount:<namespace>:<name>, got ${JSON.stringify(bad)}`);
  }
  return list;
}

function envNames(value: unknown): string[] {
  const list = stringList(value, "passEnv");
  const bad = list.find((name) => !ENV_NAME.test(name));
  if (bad !== undefined) throw new Error(`config: passEnv must hold environment variable names, got ${JSON.stringify(bad)}`);
  return list;
}

function command(value: unknown, field = "piCommand"): string[] {
  const list = stringList(value, field);
  if (list.length === 0) throw new Error(`config: ${field} must not be empty`);
  return list;
}

function contextWorkspace(value: unknown): ContextWorkspaceConfig {
  if (!isRecord(value)) throw new Error("config: contextWorkspace must be an object");
  return {
    prepare: command(value.prepare, "contextWorkspace.prepare"),
    remove: value.remove === undefined ? [] : stringList(value.remove, "contextWorkspace.remove"),
  };
}

function skills(value: unknown): SkillConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("config: skills must be a list");
  return value.map((skill, index) => {
    if (!isRecord(skill)) throw new Error(`config: skills[${index}] must be an object`);
    return {
      id: text(skill, "id"),
      name: text(skill, "name"),
      description: text(skill, "description"),
      tags: skill.tags === undefined ? [] : stringList(skill.tags, `skills[${index}].tags`),
      examples: skill.examples === undefined ? [] : stringList(skill.examples, `skills[${index}].examples`),
    };
  });
}
