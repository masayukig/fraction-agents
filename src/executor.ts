import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Role, TaskState, type Message, type Part } from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";

import type { Artifacts } from "./artifacts.ts";
import { filesOf, withoutFileBytes } from "./inbox.ts";
import { REPLY_EXTENSION_URI, renderReply, type Replies } from "./reply.ts";
import type { PiSessions, PromptRun } from "./sessions.ts";
import type { ContextRegistry } from "./store.ts";

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
}

const SETTLE_WAIT_MS = 10_000;

/** A task whose prompt is paused on a question to the caller. */
interface Waiting {
  caller: string;
  contextId: string;
  run: PromptRun;
  questionId: string;
  timer: NodeJS.Timeout;
  /** Whether a request of the task (the one that started it, or an answer) activated the reply extension. */
  structured: boolean;
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

    const run = this.#options.sessions.run(
      { contextId, caller, sessionPath: join(this.#options.sessionsDir, context.sessionFile) },
      taskId,
      text,
      files,
    );
    if (!run) {
      const busy = this.#options.sessions.runningTask(contextId);
      status(
        TaskState.TASK_STATE_REJECTED,
        busy !== undefined && this.#waiting.has(busy)
          ? `This context is waiting for an answer to task ${busy}. Answer it by sending a message with that taskId, or cancel it.`
          : "This context is busy with another task. Wait for it to finish and send again.",
      );
      return;
    }
    console.log(`task ${taskId}: started in context ${contextId} for ${caller}`);
    status(TaskState.TASK_STATE_WORKING);
    await this.#drive(taskId, contextId, caller, run, bus, wantsStructuredReply(request));
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
    waiting.run.answer(waiting.questionId, textOf(userMessage));
    console.log(`task ${taskId}: answered`);
    publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_WORKING);
    await this.#drive(taskId, contextId, caller, waiting.run, bus, waiting.structured || wantsStructuredReply(request));
  }

  /** Follows the run to its next question or its end, and reports it. */
  async #drive(
    taskId: string,
    contextId: string,
    caller: string,
    run: PromptRun,
    bus: ExecutionEventBus,
    structured: boolean,
  ): Promise<void> {
    const step = await run.next();
    if (step.kind === "question") {
      const timer = setTimeout(() => this.#giveUp(taskId), this.#options.inputTimeoutMs);
      timer.unref();
      this.#waiting.set(taskId, { caller, contextId, run, questionId: step.question.id, timer, structured });
      console.log(`task ${taskId}: waiting for the caller's answer`);
      publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_INPUT_REQUIRED, step.question.text);
      return;
    }
    const outcome = step.outcome;
    this.#options.contexts.touch(contextId, this.#options.now());
    console.log(`task ${taskId}: ${outcome.status}`);

    switch (outcome.status) {
      case "completed": {
        const reply = this.#options.replies.take(contextId, taskId);
        const parts: Part[] = [
          { content: { $case: "text", value: reply ? renderReply(reply) : outcome.text }, metadata: {}, filename: "", mediaType: "text/plain" },
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
        publishStatus(bus, taskId, contextId, TaskState.TASK_STATE_COMPLETED);
        return;
      }
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

  /** Stops a paused run: dismisses its question, aborts the prompt and lets it settle unseen. */
  async #abandon(taskId: string): Promise<Waiting | undefined> {
    const waiting = this.#waiting.get(taskId);
    if (!waiting) return undefined;
    this.#waiting.delete(taskId);
    clearTimeout(waiting.timer);
    waiting.run.answer(waiting.questionId, undefined);
    await this.#options.sessions.abort(taskId);
    // Waits (for a while) until the prompt has settled, so the context is free again when this returns.
    await Promise.race([drain(waiting.run), new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS).unref())]);
    this.#options.artifacts.discard(waiting.contextId);
    this.#options.replies.discard(waiting.contextId);
    return waiting;
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
