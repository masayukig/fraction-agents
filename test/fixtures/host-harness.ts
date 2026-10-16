// What the host's tests share: callers and their tokens, a config on the fake pi, a running host and the A2A calls.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { A2A_AUDIENCE, type TokenReviewer } from "../../src/auth.ts";
import { parseConfig, type Config } from "../../src/config.ts";
import { createHost, type Host } from "../../src/host.ts";

export const OWNER = "system:serviceaccount:fraction-agents:owner";
export const CLAUDE = "system:serviceaccount:fraction-agents:claude";
export const STRANGER = "system:serviceaccount:default:stranger";
export const FAKE_PI = resolve(import.meta.dirname, "fake-pi.ts");
export const FAKE_HOOK = resolve(import.meta.dirname, "fake-hook.ts");

export const reviewer: TokenReviewer = {
  async review(token) {
    const users: Record<string, string> = { owner: OWNER, claude: CLAUDE, stranger: STRANGER };
    if (token === "apiserver") {
      return { authenticated: true, username: OWNER, audiences: ["https://kubernetes.default.svc"] };
    }
    const username = users[token];
    return username ? { authenticated: true, username, audiences: [A2A_AUDIENCE] } : { authenticated: false };
  },
};

export type Json = any;

export interface Running {
  host: Host;
  url: string;
  config: Config;
}

const running: Host[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close();
});

export function makeConfig(dir: string, overrides: Record<string, unknown> = {}): Config {
  mkdirSync(join(dir, "agent"), { recursive: true });
  return parseConfig({
    name: "test-agent",
    description: "An agent for tests.",
    agentDir: join(dir, "agent"),
    dataDir: join(dir, "data"),
    allowedCallers: [OWNER, CLAUDE],
    publicUrl: "https://agents.example.test/test-agent",
    piCommand: [process.execPath, FAKE_PI],
    skills: [{ id: "echo", name: "Echo", description: "Echoes the request." }],
    ...overrides,
  });
}

export async function start(config: Config, now?: () => number): Promise<Running> {
  const host = createHost({ config, tokenReviewer: reviewer, ...(now ? { now } : {}) });
  running.push(host);
  const url = await host.listen(0, "127.0.0.1");
  return { host, url, config };
}

/** Closes a host before the end of the test, for a test that restarts it. */
export async function stop(host: Host): Promise<void> {
  running.splice(running.indexOf(host), 1);
  await host.close();
}

export async function post(
  url: string,
  token: string | undefined,
  method: string,
  params: Json,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: Json; headers: Headers }> {
  const headers: Record<string, string> = { "content-type": "application/json", "a2a-version": "1.0", ...extraHeaders };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
}

export async function rpc(url: string, token: string, method: string, params: Json): Promise<Json> {
  const { status, body } = await post(url, token, method, params);
  assert.equal(status, 200, JSON.stringify(body));
  return body;
}

export function message(text: string, extra: Record<string, unknown> = {}): Json {
  return { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], ...extra };
}

export async function send(url: string, token: string, text: string, extra: Record<string, unknown> = {}): Promise<Json> {
  const body = await rpc(url, token, "SendMessage", { message: message(text, extra), configuration: { returnImmediately: true } });
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result.task;
}

export const TERMINAL = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"]);

export async function waitForTask(url: string, token: string, id: string): Promise<Json> {
  for (let i = 0; i < 200; i++) {
    const body = await rpc(url, token, "GetTask", { id });
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    if (TERMINAL.has(body.result.status.state)) return body.result;
    await sleep(25);
  }
  throw new Error(`task ${id} did not finish`);
}

export async function waitForState(url: string, token: string, id: string, state: string): Promise<Json> {
  for (let i = 0; i < 200; i++) {
    const body = await rpc(url, token, "GetTask", { id });
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    if (body.result.status.state === state) return body.result;
    assert.equal(TERMINAL.has(body.result.status.state), false, `task ended as ${body.result.status.state}`);
    await sleep(25);
  }
  throw new Error(`task ${id} did not reach ${state}`);
}

export async function answer(url: string, token: string, task: Json, text: string): Promise<Json> {
  return rpc(url, token, "SendMessage", {
    message: message(text, { contextId: task.contextId, taskId: task.id }),
    configuration: { returnImmediately: true },
  });
}

export function resultText(task: Json): string {
  return task.artifacts?.[0]?.parts?.[0]?.text;
}

export function statusText(task: Json): string {
  return task.status?.message?.parts?.[0]?.text ?? "";
}

export function spawns(config: Config): string[] {
  const log = join(config.workDir, "spawns.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fraction-agents-host-"));
}
