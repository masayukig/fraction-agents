import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { Config } from "../src/config.ts";
import {
  answer,
  makeConfig,
  resultText,
  rpc,
  send,
  start,
  statusText,
  stop,
  tempDir,
  waitForState,
  waitForTask,
  type Json,
} from "./fixtures/host-harness.ts";

const REPLY = {
  summary: "Half of the survey.",
  sections: [{ title: "Found so far", body: "Three papers." }],
  sources: [],
};
const RENDERED = "Half of the survey.\n\n## Found so far\n\nThree papers.";

function logged(config: Config, name: string): string[] {
  const log = join(config.workDir, name);
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

/** The prompts pi got, in the order they started, without the host's note. */
function prompts(config: Config): string[] {
  return logged(config, "prompts.log").map((prompt) => prompt.replace(/\n\n\[fraction-agents host\][\s\S]*$/, ""));
}

async function state(url: string, id: string): Promise<string> {
  return (await rpc(url, "owner", "GetTask", { id })).result.status.state;
}

describe("time limit of a task", () => {
  function limited(seconds: number, grace: number, overrides: Record<string, unknown> = {}): Config {
    return makeConfig(tempDir(), { taskTimeLimitSeconds: seconds, taskTimeLimitGraceSeconds: grace, ...overrides });
  }

  it("tells the agent to wrap up and completes the task with what it returns within the grace period", async () => {
    const config = limited(0.3, 10);
    const { url } = await start(config);
    const task = await send(url, "owner", `slow-reply:${JSON.stringify(REPLY)}`);
    const done = await waitForTask(url, "owner", task.id);
    assert.equal(done.status.state, "TASK_STATE_COMPLETED");
    assert.equal(resultText(done), RENDERED, "the reply is not rewritten");
    assert.match(statusText(done), /time limit/i);
    const [steer] = logged(config, "steers.log");
    assert.match(steer!, /time limit/i, "the agent is told why");
  });

  it("stops the prompt after the grace period and returns the reply submitted so far", async () => {
    const { url } = await start(limited(0.2, 0.3));
    const task = await send(url, "owner", `reply-then-wait:${JSON.stringify(REPLY)}`);
    const done = await waitForTask(url, "owner", task.id);
    assert.equal(done.status.state, "TASK_STATE_COMPLETED");
    assert.equal(resultText(done), RENDERED);
    assert.match(statusText(done), /time limit/i);
  });

  it("returns a fixed text that says how to go on when no reply was submitted", async () => {
    const { url } = await start(limited(0.2, 0.3));
    const task = await send(url, "owner", "wait:600000");
    const done = await waitForTask(url, "owner", task.id);
    assert.equal(done.status.state, "TASK_STATE_COMPLETED");
    assert.match(resultText(done), /time limit/i);
    assert.match(resultText(done), /same context/i);
    assert.match(statusText(done), /time limit/i);
  });

  it("goes on in the same context after the limit, remembering the work so far", async () => {
    const { url } = await start(limited(0.2, 0.2));
    const task = await send(url, "owner", "wait:600000");
    await waitForTask(url, "owner", task.id);
    const next = await send(url, "owner", "continue", { contextId: task.contextId });
    assert.match(resultText(await waitForTask(url, "owner", next.id)), /^echo:continue\|turn=2\|/);
  });

  it("does not count the time the task waits for the caller's answer", async () => {
    const config = limited(0.6, 0.2);
    const { url } = await start(config);
    const task = await send(url, "owner", "ask:Which page?");
    await waitForState(url, "owner", task.id, "TASK_STATE_INPUT_REQUIRED");
    await sleep(900);
    await answer(url, "owner", task, "the index");
    const done = await waitForTask(url, "owner", task.id);
    assert.equal(resultText(done), "answers:the index");
    assert.equal(statusText(done), "");
    assert.deepEqual(logged(config, "steers.log"), []);
  });

  it("does not count the time the task waits for its turn", async () => {
    const config = limited(0.8, 0.2, { maxConcurrentTasks: 1 });
    const { url } = await start(config);
    const first = await send(url, "owner", "wait:600");
    const second = await send(url, "owner", "wait:500");
    assert.match(resultText(await waitForTask(url, "owner", first.id)), /^echo:wait:600/);
    const done = await waitForTask(url, "owner", second.id);
    assert.match(resultText(done), /^echo:wait:500/);
    assert.equal(statusText(done), "");
  });

  it("can still be canceled during the grace period", async () => {
    const { url } = await start(limited(0.2, 60));
    const task = await send(url, "owner", "wait:600000");
    await sleep(400);
    await rpc(url, "owner", "CancelTask", { id: task.id });
    assert.equal((await waitForTask(url, "owner", task.id)).status.state, "TASK_STATE_CANCELED");
  });

  it("tells the agent its limit and when the task started", async () => {
    const config = limited(5400, 300);
    const { url } = await start(config);
    const task = await send(url, "owner", "hello");
    assert.match(resultText(await waitForTask(url, "owner", task.id)), /^echo:hello\|/, "the agent reads the request as sent");
    const [prompt] = logged(config, "prompts.log");
    assert.match(prompt!, /^hello\n\n\[fraction-agents host\]/);
    assert.match(prompt!, /90 minutes/);
    assert.match(prompt!, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("adds nothing to the prompt without a limit", async () => {
    const config = makeConfig(tempDir());
    const { url } = await start(config);
    const task = await send(url, "owner", "hello");
    await waitForTask(url, "owner", task.id);
    assert.deepEqual(logged(config, "prompts.log"), ["hello"]);
  });
});

describe("tasks running at once", () => {
  function queued(max: number): Config {
    return makeConfig(tempDir(), { maxConcurrentTasks: max });
  }

  it("keeps tasks over the limit submitted and runs them in the order they came", async () => {
    const config = queued(1);
    const { url } = await start(config);
    const first = await send(url, "owner", "wait:400");
    const second = await send(url, "owner", "two");
    const third = await send(url, "owner", "three");
    assert.equal(await state(url, second.id), "TASK_STATE_SUBMITTED");
    assert.equal(await state(url, third.id), "TASK_STATE_SUBMITTED");
    for (const task of [first, second, third]) {
      assert.equal((await waitForTask(url, "owner", task.id)).status.state, "TASK_STATE_COMPLETED");
    }
    assert.deepEqual(prompts(config), ["wait:400", "two", "three"]);
  });

  it("runs as many tasks at once as the limit allows", async () => {
    const { url } = await start(queued(2));
    const first = await send(url, "owner", "wait:400");
    const second = await send(url, "owner", "wait:400");
    const third = await send(url, "owner", "three");
    await waitForState(url, "owner", second.id, "TASK_STATE_WORKING");
    assert.equal(await state(url, third.id), "TASK_STATE_SUBMITTED");
    for (const task of [first, second, third]) await waitForTask(url, "owner", task.id);
  });

  it("keeps the context of a waiting task busy", async () => {
    const { url } = await start(queued(1));
    await send(url, "owner", "wait:400");
    const waiting = await send(url, "owner", "two");
    const again = await send(url, "owner", "again", { contextId: waiting.contextId });
    const rejected = await waitForTask(url, "owner", again.id);
    assert.equal(rejected.status.state, "TASK_STATE_REJECTED");
    assert.match(statusText(rejected), /busy/);
  });

  it("cancels a waiting task without running it", async () => {
    const config = queued(1);
    const { url } = await start(config);
    const first = await send(url, "owner", "wait:400");
    const waiting = await send(url, "owner", "never");
    await rpc(url, "owner", "CancelTask", { id: waiting.id });
    assert.equal((await waitForTask(url, "owner", waiting.id)).status.state, "TASK_STATE_CANCELED");
    const next = await send(url, "owner", "next");
    await waitForTask(url, "owner", first.id);
    assert.equal((await waitForTask(url, "owner", next.id)).status.state, "TASK_STATE_COMPLETED");
    assert.deepEqual(prompts(config), ["wait:400", "next"]);
    const again = await send(url, "owner", "after", { contextId: waiting.contextId });
    assert.equal((await waitForTask(url, "owner", again.id)).status.state, "TASK_STATE_COMPLETED", "the context is free");
  });

  it("frees the slot while a task waits for an answer, and runs the answered task before new ones", async () => {
    const config = queued(1);
    const { url } = await start(config);
    const asking = await send(url, "owner", "ask:Which page?");
    await waitForState(url, "owner", asking.id, "TASK_STATE_INPUT_REQUIRED");
    const busy = await send(url, "owner", "wait:500");
    await waitForState(url, "owner", busy.id, "TASK_STATE_WORKING");
    const fresh = await send(url, "owner", "fresh");
    const body = await answer(url, "owner", asking, "the index");
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    assert.equal(await state(url, asking.id), "TASK_STATE_SUBMITTED", "the answered task waits for its turn");
    const answered = await waitForTask(url, "owner", asking.id);
    assert.equal(resultText(answered), "answers:the index");
    const last = await waitForTask(url, "owner", fresh.id);
    assert.ok(answered.status.timestamp <= last.status.timestamp, "the answered task finished first");
    assert.deepEqual(prompts(config), ["ask:Which page?", "wait:500", "fresh"]);
  });

  it("cancels an answered task that waits for its turn", async () => {
    const config = queued(1);
    const { url } = await start(config);
    const asking = await send(url, "owner", "ask:Which page?");
    await waitForState(url, "owner", asking.id, "TASK_STATE_INPUT_REQUIRED");
    const busy = await send(url, "owner", "wait:400");
    await waitForState(url, "owner", busy.id, "TASK_STATE_WORKING");
    await answer(url, "owner", asking, "the index");
    await rpc(url, "owner", "CancelTask", { id: asking.id });
    assert.equal((await waitForTask(url, "owner", asking.id)).status.state, "TASK_STATE_CANCELED");
    await waitForTask(url, "owner", busy.id);
    const next = await send(url, "owner", "next", { contextId: asking.contextId });
    assert.match(resultText(await waitForTask(url, "owner", next.id)), /^echo:next/);
  });

  it("fails the waiting tasks when the host restarts", async () => {
    const config = queued(1);
    const first = await start(config);
    await send(first.url, "owner", "wait:600000");
    const waiting = await send(first.url, "owner", "two");
    await stop(first.host);
    const second = await start(config);
    const again: Json = (await rpc(second.url, "owner", "GetTask", { id: waiting.id })).result;
    assert.equal(again.status.state, "TASK_STATE_FAILED");
  });
});
