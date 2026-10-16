import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Role, TaskState, type Message, type Part } from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";

import type { Artifacts } from "./artifacts.ts";
import { filesOf, withoutFileBytes } from "./inbox.ts";
import { REPLY_EXTENSION_URI, renderReply, type Replies, type Reply } from "./reply.ts";
import type { PiSessions, PromptRun } from "./sessions.ts";
import type { TaskSlots } from "./slots.ts";
import type { ContextRegistry } from "./store.ts";

/** How long a task may work, and how long it then has to wrap up (ADR 0019). */
export interface TimeLimit {
  limitMs: number;
  graceMs: number;
}

export interface PiAgentExecutorOptions {
  contexts: ContextRegistry;
  sessions: PiSessions;
  sessionsDir: string;
  /** The images tasks hand over, and the URL each is served at. */
  artifacts: Artifacts;
  /** The replies tasks submit in the shape of the reply contract (ADR 0015). */
  replies: Replies;
  artifactUrl: (id: string) => string;
  now: () => number;
  /** How long a question to the caller stays open before the task fails. */
  inputTimeoutMs: number;
  /** Marks a task failed outside of a request, when its question timed out. */
  failTask: (taskId: string, caller: string, reason: string) => void;
  /** The turns of the tasks that work at once. */
  slots: TaskSlots;
  /** No limit when not set. */
  timeLimit?: TimeLimit;
  /**
   * Keeps the reply of a completed task as a report (ADR 0020), and returns the URL people read it at, if there are
   * pages for people. Not set when the agent keeps no reports.
   */
  keepReport?: (report: CompletedReply) => string | undefined;
}

/** A reply a task completed with. */
export interface CompletedReply {
  taskId: string;
  contextId: string;
  caller: string;
  reply: Reply;
  /** Whether the task reached its time limit and returned the work so far. */
  partial: boolean;
}

/** The title of the section the host adds to a reply with the report page's URL. */
export const REPORT_SECTION_TITLE = "レポート";
/** The reply contract's limit of sections (`reply.schema.json`). */
const SECTIONS_LIMIT = 50;

const SETTLE_WAIT_MS = 10_000;

/** What the host tells pi when a task reaches its time limit. Fixed: the host's own words, not the caller's. */
function timeUpNotice(graceMs: number): string {
  return (
    `[fraction-agents host] This task has reached its time limit. Stop the work now: submit your reply with what ` +
    `you have so far, say in it that it is partial, and finish within ${duration(graceMs)}.`
  );
}

/** The result's text when the host stopped a task at its time limit before the agent submitted a reply. */
export const STOPPED_AT_TIME_LIMIT =
  "The task reached its time limit and was stopped before the agent submitted a reply. " +
  'Send a message in the same context (for example "continue") to go on from where it stopped.';

/** The status message of a task that reached its time limit and returned the work so far. */
export const PARTIAL_AT_TIME_LIMIT =
  "The task reached its time limit, so the result holds the work so far. Send a message in the same context to go on.";

/** The note the host adds to a prompt when tasks have a time limit, so that the agent can plan its time. */
function timeLimitNote(limitMs: number, startedAt: Date): string {
  return (
    `\n\n[fraction-agents host] This task may work for ${duration(limitMs)}, counted from ` +
    `${startedAt.toISOString()} while it does not wait for an answer. When the time is up the host tells you to ` +
    "wrap up. Run `date` to see the time."
  );
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
}

/**
 * The working time of one task against its time limit (ADR 0019). It runs only while the task works: not while it
 * waits for its turn or for the caller's answer. When the limit is reached the agent is told to wrap up; when the
 * grace period after that is over too, the prompt is stopped.
 */
class TaskClock {
  readonly #limit: TimeLimit;
  readonly #onLimit: () => void;
  readonly #onGraceOver: () => void;
  #phase: "working" | "grace" | "stopped" = "working";
  #remainingMs: number;
  #since = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(limit: TimeLimit, onLimit: () => void, onGraceOver: () => void) {
    this.#limit = limit;
    this.#remainingMs = limit.limitMs;
    this.#onLimit = onLimit;
    this.#onGraceOver = onGraceOver;
  }

  /** Whether the task has reached its limit. */
  get reached(): boolean {
    return this.#phase !== "working";
  }

  /** Whether the host stopped the prompt after the grace period. */
  get stopped(): boolean {
    return this.#phase === "stopped";
  }

  resume(): void {
    if (this.#phase === "stopped" || this.#timer) return;
    this.#since = Date.now();
    this.#timer = setTimeout(() => this.#fire(), Math.max(0, this.#remainingMs));
    this.#timer.unref();
  }

  pause(): void {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#remainingMs -= Date.now() - this.#since;
  }

  #fire(): void {
    this.#timer = undefined;
    if (this.#phase === "working") {
      this.#phase = "grace";
      this.#remainingMs = this.#limit.graceMs;
      this.#onLimit();
      this.resume();
      return;
    }
    this.#phase = "stopped";
    this.#onGraceOver();
  }
}

/** A task whose prompt is paused on a question to the caller. */
interface Waiting {
  caller: string;
  contextId: string;
  run: PromptRun;
  questionId: string;
  timer: NodeJS.Timeout;
  /** Whether a request of the task (the one that started it, or an answer) activated the reply extension. */
  structured: boolean;
  clock: TaskClock | undefined;
}

/**
 * Runs each A2A task as one prompt in its context's pi session and reports the last assistant text as the result,
 * followed by one artifact per image the agent handed over (ADR 0012). When the agent submitted a reply in the shape
 * of the reply contract, the result's text is that reply written out, and a caller that activated the reply
 * extension also gets the reply itself as a data part (ADR 0015).
 * When an extension in pi asks a free-form question (`ctx.ui.input`), the task goes to INPUT_REQUIRED with the
 * question; the caller's next message to the same task is the answer, and the same prompt carries on.
 * Files the caller sends with a new task are saved in the context's working directory for pi (ADR 0019); an answer
 * is taken as text only.
 */
export class PiAgentExecutor implements AgentExecutor {
  readonly #options: PiAgentExecutorOptions;
  readonly #waiting = new Map<string, Waiting>();
  /** Tasks answered by the caller that wait for their turn to carry on. */
  readonly #answered = new Set<string>();

  constructor(options: PiAgentExecutorOptions) {
    this.#options = options;
  }

  /** Whether the task is paused on a question to the caller. */
  isWaiting(taskId: string): boolean {
    return this.#waiting.has(taskId);
  }

  async execute(request: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = request;
    const caller = request.context.user?.userName ?? "";
    if (request.task?.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED) {
      await this.#resume(request, bus, caller);
      return;
    }
    // The request handler has already checked or created the context for this caller.
    const context = this.#options.contexts.get(contextId, caller);
    if (!context) throw new Error(`context ${contextId} does not belong to ${caller}`);

    bus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: timestamp() },
        artifacts: [],
        // Without the files' bytes, so that the task the SDK answers SendMessage with does not carry them back.
        history: [withoutFileBytes(userMessage)],
        metadata: {},
      }),
    );
    const status = (state: TaskState, text?: string) => publishStatus(bus, taskId, contextId, state, text);

    const files = filesOf(userMessage);
    if (typeof files === "string") {
      status(TaskState.TASK_STATE_REJECTED, files);
      return;
    }
    const text = textOf(userMessage);
    if (text === "" && files.length === 0) {
      status(TaskState.TASK_STATE_REJECTED, "This agent accepts text parts and file parts (raw bytes); the message had neither.");
      return;
    }

    const { slots, timeLimit } = this.#options;
    const turn = slots.acquire(taskId);
    const run = this.#options.sessions.run(
      { contextId, caller, sessionPath: join(this.#options.sessionsDir, context.sessionFile) },
      taskId,
      timeLimit ? text + timeLimitNote(timeLimit.limitMs, new Date()) : text,
      files,
      turn.granted,
    );
    if (!run) {
      slots.cancel(taskId);
      slots.release(taskId);
      const busy = this.#options.sessions.runningTask(contextId);
      status(
        TaskState.TASK_STATE_REJECTED,
        busy !== undefined && this.#waiting.has(busy)
          ? `This context is waiting for an answer to task ${busy}. Answer it by sending a message with that taskId, or cancel it.`
          : "This context is busy with another task. Wait for it to finish and send again.",
      );
      return;
    }
    if (!turn.immediate) console.log(`task ${taskId}: waiting for its turn in context ${contextId} for ${caller}`);
    // When the task is canceled while it waits, the run settles as aborted without starting.
    const clock = timeLimit ? this.#clock(taskId, timeLimit) : undefined;
    if (await turn.granted) {
      console.log(`task ${taskId}: started in context ${contextId} for ${caller}`);
      status(TaskState.TASK_STATE_WORKING);
    }
    await this.#drive(taskId, contextId, caller, run, bus, wantsStructuredReply(request), clock);
  }

  #clock(taskId: string, limit: TimeLimit): TaskClock {
    return new TaskClock(
      limit,
      () => {
        console.log(`task ${taskId}: reached the time limit; telling the agent to wrap up`);
        void this.#options.sessions.steer(taskId, timeUpNotice(limit.graceMs)).then((told) => {
          if (!told) console.log(`task ${taskId}: could not tell the agent about the time limit`);
        });
      },
      () => {
        console.log(`task ${taskId}: no end within the grace period; stopping the prompt`);
        void this.#options.sessions.abort(taskId);
      },
    );
  }

  /** Delivers the caller's answer to the question the task is paused on, and carries on with the prompt. */
  async #resume(request: RequestContext, bus: ExecutionEventBus, caller: string): Promise<void> {
    const { taskId, contextId, userMessage } = request;
    const waiting = this.#waiting.get(taskId);
    if (!waiting || waiting.caller !== caller) {
      publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_FAILED, "The agent is no longer waiting for this answer.");
      return;
    }
    this.#waiting.delete(taskId);
    clearTimeout(waiting.timer);
    console.log(`task ${taskId}: answered`);
    // The answer is taken now and handed to pi when the task's turn comes, before the new tasks'.
    const turn = this.#options.slots.acquire(taskId, true);
    if (!turn.immediate) {
      this.#answered.add(taskId);
      publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_SUBMITTED);
      console.log(`task ${taskId}: waiting for its turn to carry on`);
    }
    const granted = await turn.granted;
    this.#answered.delete(taskId);
    if (!granted) {
      await this.#stopPaused(taskId, waiting);
      publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_CANCELED, "The task was canceled.");
      return;
    }
    waiting.run.answer(waiting.questionId, textOf(userMessage));
    publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_WORKING);
    await this.#drive(
      taskId,
      contextId,
      caller,
      waiting.run,
      bus,
      waiting.structured || wantsStructuredReply(request),
      waiting.clock,
    );
  }

  /** Follows the run to its next question or its end, and reports it. */
  async #drive(
    taskId: string,
    contextId: string,
    caller: string,
    run: PromptRun,
    bus: ExecutionEventBus,
    structured: boolean,
    clock: TaskClock | undefined,
  ): Promise<void> {
    clock?.resume();
    const step = await run.next();
    clock?.pause();
    // A task that waits for the caller's answer does not hold a turn: the answer may take a day.
    this.#options.slots.release(taskId);
    if (step.kind === "question") {
      const timer = setTimeout(() => this.#giveUp(taskId), this.#options.inputTimeoutMs);
      timer.unref();
      this.#waiting.set(taskId, { caller, contextId, run, questionId: step.question.id, timer, structured, clock });
      console.log(`task ${taskId}: waiting for the caller's answer`);
      publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_INPUT_REQUIRED, step.question.text);
      return;
    }
    const outcome = step.outcome;
    this.#options.contexts.touch(contextId, this.#options.now());
    console.log(`task ${taskId}: ${outcome.status}`);

    // A task stopped at its time limit completes with the work so far, not as canceled or failed (ADR 0019).
    if (clock?.stopped && outcome.status !== "completed") {
      this.#complete(taskId, contextId, caller, bus, structured, STOPPED_AT_TIME_LIMIT, true);
      return;
    }
    switch (outcome.status) {
      case "completed":
        this.#complete(taskId, contextId, caller, bus, structured, outcome.text, clock?.reached ?? false);
        return;
      case "failed":
        this.#options.artifacts.discard(contextId);
        this.#options.replies.discard(contextId);
        publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_FAILED, outcome.error);
        return;
      case "aborted":
        this.#options.artifacts.discard(contextId);
        this.#options.replies.discard(contextId);
        publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_CANCELED, "The task was canceled.");
        return;
    }
  }

  /**
   * Reports a completed task: the reply the agent submitted written out, or else `text`, followed by the images.
   * `partial` when the task reached its time limit.
   */
  #complete(
    taskId: string,
    contextId: string,
    caller: string,
    bus: ExecutionEventBus,
    structured: boolean,
    text: string,
    partial: boolean,
  ): void {
    let reply = this.#options.replies.take(contextId, taskId);
    const link = reply ? this.#options.keepReport?.({ taskId, contextId, caller, reply, partial }) : undefined;
    // The link goes to the caller as one more section of the reply, when there is room for it.
    if (reply && link !== undefined && reply.sections.length < SECTIONS_LIMIT) {
      reply = { ...reply, sections: [...reply.sections, { title: REPORT_SECTION_TITLE, body: link }] };
    }
    const parts: Part[] = [
      { content: { $case: "text", value: reply ? renderReply(reply) : text }, metadata: {}, filename: "", mediaType: "text/plain" },
    ];
    if (reply && structured) {
      parts.push({ content: { $case: "data", value: reply }, metadata: {}, filename: "", mediaType: "application/json" });
    }
    bus.publish(
      AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact: {
          artifactId: randomUUID(),
          name: "response",
          description: "",
          parts,
          metadata: {},
          extensions: parts.length > 1 ? [REPLY_EXTENSION_URI] : [],
        },
        append: false,
        lastChunk: true,
        metadata: {},
      }),
    );
    for (const image of this.#options.artifacts.collect(contextId, caller, taskId)) {
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: randomUUID(),
            name: image.name,
            description: image.description,
            parts: [
              {
                content: { $case: "url", value: this.#options.artifactUrl(image.id) },
                metadata: {},
                filename: image.name,
                mediaType: image.mediaType,
              },
            ],
            metadata: {},
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: {},
        }),
      );
    }
    publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_COMPLETED, partial ? PARTIAL_AT_TIME_LIMIT : undefined);
  }

  /** Stops a paused run: dismisses its question, aborts the prompt and lets it settle unseen. */
  async #abandon(taskId: string): Promise<Waiting | undefined> {
    const waiting = this.#waiting.get(taskId);
    if (!waiting) return undefined;
    this.#waiting.delete(taskId);
    clearTimeout(waiting.timer);
    await this.#stopPaused(taskId, waiting);
    return waiting;
  }

  /** Stops a run paused on a question: dismisses it, aborts the prompt and lets it settle unseen. */
  async #stopPaused(taskId: string, waiting: Waiting): Promise<void> {
    waiting.run.answer(waiting.questionId, undefined);
    await this.#options.sessions.abort(taskId);
    // Waits (for a while) until the prompt has settled, so the context is free again when this returns.
    await Promise.race([drain(waiting.run), new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS).unref())]);
    this.#options.artifacts.discard(waiting.contextId);
    this.#options.replies.discard(waiting.contextId);
  }

  #giveUp(taskId: string): void {
    void this.#abandon(taskId).then((waiting) => {
      if (!waiting) return;
      const seconds = Math.round(this.#options.inputTimeoutMs / 1000);
      console.log(`task ${taskId}: no answer within ${seconds} seconds`);
      this.#options.failTask(taskId, waiting.caller, `No answer came within ${seconds} seconds, so the agent stopped.`);
    });
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    // A task waiting for its turn leaves the line; its `execute` reports it canceled.
    if (this.#options.slots.cancel(taskId)) return;
    // A paused task has no `execute` running to report it, so it is reported here.
    const waiting = await this.#abandon(taskId);
    if (waiting) {
      publishStatus(bus, taskId, waiting.contextId, TaskState.TASK_STATE_CANCELED, "The task was canceled.");
      return;
    }
    // A running task settles as aborted and `execute` reports it canceled.
    if (await this.#options.sessions.abort(taskId)) return;
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: "",
        status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: timestamp() },
        metadata: {},
      }),
    );
  }
}

/** Reads a paused run to its end, dismissing any further question. */
async function drain(run: PromptRun): Promise<void> {
  for (;;) {
    const step = await run.next();
    if (step.kind === "done") return;
    run.answer(step.question.id, undefined);
  }
}

/**
 * Whether the request activates the reply extension. The caller names it in the `A2A-Extensions` service parameter;
 * the SDK has already dropped the extensions the card does not declare. When it is activated, the request's
 * context is marked so that the response says it was used.
 */
function wantsStructuredReply(request: RequestContext): boolean {
  if (!request.context.requestedExtensions?.includes(REPLY_EXTENSION_URI)) return false;
  request.context.addActivatedExtension(REPLY_EXTENSION_URI);
  return true;
}

function textOf(message: Message): string {
  return message.parts
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .filter((value) => value !== "")
    .join("\n\n");
}

function publishStatus(bus: ExecutionEventBus, taskId: string, contextId: string, state: TaskState, text?: string): void {
  bus.publish(
    AgentEvent.statusUpdate({
      taskId,
      contextId,
      status: { state, message: text === undefined ? undefined : agentMessage(taskId, contextId, text), timestamp: timestamp() },
      metadata: {},
    }),
  );
}

function timestamp(): string {
  return new Date().toISOString();
}

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [{ content: { $case: "text", value: text }, metadata: {}, filename: "", mediaType: "text/plain" }],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}
