#!/usr/bin/env node
// Runs the a2a CLI against a fraction-agents agent picked by name.
//
//   node agent.mjs --list
//   node agent.mjs <agent> <a2a arguments...>
//   node agent.mjs <agent> report list [--json]
//   node agent.mjs <agent> report get <taskId> [--format md|html] [--output <file>]
//   node agent.mjs <agent> report delete <taskId>
//
// The agent's URL and the caller's token come from a local config file
// ($FRACTION_AGENTS_CLIENT_CONFIG, else $XDG_CONFIG_HOME/fraction-agents/agents.json,
// else ~/.config/fraction-agents/agents.json). They reach a2a only through the
// environment (A2ACLI_AGENT_CARD and A2ACLI_AUTH), never through its command line,
// and this script never prints the token. The report commands call the agent's
// report endpoints (ADR 0020) themselves, with the token in the Authorization header.

import { spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const usage = `usage: agent.mjs --list
       agent.mjs <agent> <a2a arguments...>   e.g. agent.mjs wiki-keeper send --async "..."
       agent.mjs <agent> report list [--json]
       agent.mjs <agent> report get <taskId> [--format md|html] [--output <file>]
       agent.mjs <agent> report delete <taskId>`;

// A report's ID is the taskId of the task it came from. Checked before it goes into a URL path.
const REPORT_ID = /^[0-9A-Za-z][0-9A-Za-z_-]*$/;
const REQUEST_TIMEOUT_MS = 60_000;

class UserError extends Error {
  constructor(message, status = 1) {
    super(message);
    this.status = status;
  }
}

function configPath() {
  if (process.env.FRACTION_AGENTS_CLIENT_CONFIG) return process.env.FRACTION_AGENTS_CLIENT_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "fraction-agents", "agents.json");
}

function expandPath(path, base) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(base, path);
}

function loadConfig() {
  const path = configPath();
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new UserError(`cannot read the agents config ${path}: ${error.code ?? error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new UserError(`the agents config ${path} is not valid JSON: ${error.message}`);
  }
  if (typeof raw !== "object" || raw === null || typeof raw.agents !== "object" || raw.agents === null) {
    throw new UserError(`the agents config ${path} needs an "agents" object`);
  }
  const base = dirname(path);
  const agents = new Map();
  for (const [name, entry] of Object.entries(raw.agents)) {
    if (typeof entry?.url !== "string" || !URL.canParse(entry.url)) {
      throw new UserError(`agent "${name}" in ${path} needs a "url" with an absolute URL`);
    }
    const tokenFile = entry.tokenFile ?? raw.tokenFile;
    agents.set(name, {
      url: entry.url,
      tokenFile: typeof tokenFile === "string" ? expandPath(tokenFile, base) : undefined,
    });
  }
  return { path, agents };
}

function readToken(name, agent, config) {
  if (!agent.tokenFile) {
    throw new UserError(`agent "${name}" has no "tokenFile" in ${config.path} (set it on the agent or at the top level)`);
  }
  let stat;
  try {
    stat = statSync(agent.tokenFile);
  } catch (error) {
    throw new UserError(`cannot read the token file ${agent.tokenFile}: ${error.code ?? error.message}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new UserError(
      `the token file ${agent.tokenFile} can be read by others; make it private with chmod 0600 and try again`,
    );
  }
  const token = readFileSync(agent.tokenFile, "utf8").trim();
  if (token === "") throw new UserError(`the token file ${agent.tokenFile} is empty`);
  return token;
}

function list(config) {
  const width = Math.max(0, ...[...config.agents.keys()].map((name) => name.length));
  for (const [name, agent] of config.agents) {
    process.stdout.write(`${name.padEnd(width)}  ${agent.url}\n`);
  }
}

function findAgent(name, config) {
  const agent = config.agents.get(name);
  if (!agent) {
    const known = [...config.agents.keys()].join(", ") || "(none)";
    throw new UserError(`no agent named "${name}" in ${config.path}; known agents: ${known}`);
  }
  return agent;
}

function run(name, args, config) {
  const agent = findAgent(name, config);
  const token = readToken(name, agent, config);
  const child = spawn("a2a", args, {
    stdio: "inherit",
    env: { ...process.env, A2ACLI_AGENT_CARD: agent.url, A2ACLI_AUTH: `Bearer ${token}` },
  });
  child.on("error", (error) => {
    if (error.code === "ENOENT") {
      process.stderr.write(
        "agent.mjs: the a2a command is not on PATH. Install a2a-cli v0.2.0 (see the fraction-agents README).\n",
      );
      process.exit(127);
    }
    process.stderr.write(`agent.mjs: cannot start a2a: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

// Reads `report ...` arguments into a command, refusing anything else before the token is read.
function parseReport(args) {
  const [action, ...rest] = args;
  const id = (value) => {
    if (value === undefined || !REPORT_ID.test(value)) throw new UserError(usage, 2);
    return value;
  };
  if (action === "list") {
    if (rest.length === 0) return { action, json: false };
    if (rest.length === 1 && rest[0] === "--json") return { action, json: true };
    throw new UserError(usage, 2);
  }
  if (action === "delete") {
    if (rest.length !== 1) throw new UserError(usage, 2);
    return { action, id: id(rest[0]) };
  }
  if (action === "get") {
    const command = { action, id: id(rest[0]), format: "md", output: undefined };
    for (let i = 1; i < rest.length; i += 2) {
      const value = rest[i + 1];
      if (value === undefined) throw new UserError(usage, 2);
      if (rest[i] === "--format" && (value === "md" || value === "html")) command.format = value;
      else if (rest[i] === "--output" && value !== "") command.output = value;
      else throw new UserError(usage, 2);
    }
    return command;
  }
  throw new UserError(usage, 2);
}

// The report endpoints sit under the agent's URL, like the A2A endpoint.
function reportUrl(agent, path) {
  const base = agent.url.endsWith("/") ? agent.url : `${agent.url}/`;
  return new URL(path, base);
}

async function request(name, method, url, token) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      // A redirect could carry the token somewhere else; the report endpoints never redirect.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error);
    throw new UserError(`cannot reach agent "${name}" at ${url.origin}: ${reason}`, 3);
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new UserError(
      `agent "${name}" refused the token (${response.status}): it may have expired, or the agent does not accept this caller. Ask the user to issue a new token.`,
    );
  }
  return response;
}

async function report(name, command, config) {
  const agent = findAgent(name, config);
  const token = readToken(name, agent, config);
  const unexpected = async (response) => {
    await response.body?.cancel();
    return new UserError(`agent "${name}" answered ${response.status} ${response.statusText}`.trimEnd());
  };

  if (command.action === "list") {
    const response = await request(name, "GET", reportUrl(agent, "reports"), token);
    if (response.status === 404) {
      await response.body?.cancel();
      throw new UserError(`agent "${name}" does not keep reports`);
    }
    if (response.status !== 200) throw await unexpected(response);
    const body = await response.json();
    if (command.json) {
      process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
      return;
    }
    const reports = Array.isArray(body?.reports) ? body.reports : [];
    if (reports.length === 0) process.stderr.write(`agent.mjs: agent "${name}" has no reports of yours\n`);
    for (const r of reports) {
      process.stdout.write(`${r.id}  ${r.createdAt}  ${r.partial ? "[partial] " : ""}${r.title}\n`);
    }
    return;
  }

  const notFound = `report ${command.id} not found on agent "${name}" (no such task, already deleted, sent by another caller, or the agent does not keep reports)`;
  if (command.action === "delete") {
    const response = await request(name, "DELETE", reportUrl(agent, `reports/${command.id}`), token);
    if (response.status === 404) {
      await response.body?.cancel();
      throw new UserError(notFound);
    }
    if (response.status !== 204 && response.status !== 200) throw await unexpected(response);
    await response.body?.cancel();
    process.stderr.write(`agent.mjs: deleted report ${command.id}\n`);
    return;
  }

  const response = await request(name, "GET", reportUrl(agent, `reports/${command.id}.${command.format}`), token);
  if (response.status === 404) {
    await response.body?.cancel();
    throw new UserError(notFound);
  }
  if (response.status !== 200) throw await unexpected(response);
  const text = await response.text();
  if (command.output === undefined) {
    process.stdout.write(text);
    return;
  }
  writeFileSync(command.output, text);
  process.stderr.write(`agent.mjs: wrote report ${command.id} to ${command.output}\n`);
}

async function main(argv) {
  if (argv[0] === "--list" && argv.length === 1) {
    list(loadConfig());
    return;
  }
  if (argv.length < 2 || argv[0].startsWith("-")) throw new UserError(usage, 2);
  const [name, ...args] = argv;
  if (args[0] === "report") {
    const command = parseReport(args.slice(1));
    await report(name, command, loadConfig());
    return;
  }
  run(name, args, loadConfig());
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UserError)) throw error;
  process.stderr.write(`agent.mjs: ${error.message}\n`);
  process.exit(error.status);
}
