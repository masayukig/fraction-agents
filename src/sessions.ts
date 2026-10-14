import { join } from "node:path";

import { ARTIFACT_OUTBOX_ENV, artifactOutbox } from "./artifacts.ts";
import { saveToInbox, type InboundFile } from "./inbox.ts";
import { PiRpcProcess, type DialogRequest, type PromptOutcome } from "./pi-rpc.ts";
import { REPLY_FILE_ENV, replyFile } from "./reply.ts";
import type { ContextWorkspaces } from "./workspace.ts";

/** The environment variable that tells pi (and the extensions in it) who called. */
export const CALLER_ENV = "FRACTION_AGENTS_CALLER";

/** The environment variable that tells pi (and the extensions in it) which context it runs for. */
export const CONTEXT_ENV = "FRACTION_AGENTS_CONTEXT_ID";

/**
 * What pi gets from the host's environment by default: enough to run, find commands and read the locale and time
 * zone. Nothing else is passed, so credentials in the host's environment do not reach the agent.
 */
export const PI_BASE_ENV = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "TZ",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
] as const;

/** What a running prompt does next: put a question to the caller, or finish. */
export type RunStep = { kind: "question"; question: DialogRequest } | { kind: "done"; outcome: PromptOutcome };

/** One prompt running in a context's pi process, seen as the questions it asks and then its outcome. */
export class PromptRun {
  readonly #steps: RunStep[] = [];
  #wake: (() => void) | undefined;
  #process: PiRpcProcess | undefined;

  /** Resolves with the next question, or with the outcome once the prompt has settled. */
  async next(): Promise<RunStep> {
    while (this.#steps.length === 0) await new Promise<void>((resolve) => (this.#wake = resolve));
    return this.#steps.shift()!;
  }

  /** Answers a question the run asked. `undefined` dismisses it. */
  answer(id: string, text: string | undefined): void {
    this.#process?.respondDialog(id, text);
  }

  attach(process: PiRpcProcess): void {
    this.#process = process;
  }

  push(step: RunStep): void {
    this.#steps.push(step);
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}

export interface SessionTarget {
  contextId: string;
  /** Absolute path of the context's session file. */
  sessionPath: string;
  caller: string;
}

export interface PiEnvironmentOptions {
  agentDir: string;
  /** The host's data directory; the context's artifact outbox and reply file are under it. */
  dataDir: string;
  /** Further environment variable names to pass from the host, on top of {@link PI_BASE_ENV}. */
  passEnv: readonly string[];
}

/**
 * The environment pi (and a context's workspace commands) run with: the minimal variables and the configured
 * names from the host's environment, and what the host tells the agent. Nothing else of the host's reaches it.
 */
export function piEnvironment(options: PiEnvironmentOptions, caller: string, contextId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...PI_BASE_ENV, ...options.passEnv]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.PI_CODING_AGENT_DIR = options.agentDir;
  env[CALLER_ENV] = caller;
  env[CONTEXT_ENV] = contextId;
  env[ARTIFACT_OUTBOX_ENV] = artifactOutbox(join(options.dataDir, "artifacts"), contextId);
  env[REPLY_FILE_ENV] = replyFile(join(options.dataDir, "replies"), contextId);
  return env;
}

export interface PiSessionsOptions extends PiEnvironmentOptions {
  piCommand: readonly string[];
  workspaces: ContextWorkspaces;
  idleTimeoutMs: number;
}

interface Entry {
  /** Absent until the workspace is prepared and pi is started. */
  process?: PiRpcProcess;
  /** The task running in this context, if any. One at a time. */
  taskId?: string;
  /** Set when the task is canceled before pi was started for it. */
  aborted?: boolean;
  idleTimer?: NodeJS.Timeout;
}

/**
 * The pi processes of the contexts, one per context. A process is started on the first task of a context (or
 * of a context whose process has stopped) on the context's session file, and stopped when unused for a while.
 */
export class PiSessions {
  readonly #options: PiSessionsOptions;
  readonly #entries = new Map<string, Entry>();

  constructor(options: PiSessionsOptions) {
    this.#options = options;
  }

  isBusy(contextId: string): boolean {
    return this.#entries.get(contextId)?.taskId !== undefined;
  }

  /** The task running in the context, if any. */
  runningTask(contextId: string): string | undefined {
    return this.#entries.get(contextId)?.taskId;
  }

  /**
   * Runs one prompt in the context's pi process. The files the caller sent are saved in the context's working
   * directory once it is prepared, and the prompt ends with a note of where they are (ADR 0019). Returns
   * `undefined` at once, without running anything, if another task is running in the context.
   */
  run(target: SessionTarget, taskId: string, text: string, files: readonly InboundFile[] = []): PromptRun | undefined {
    let entry = this.#entries.get(target.contextId);
    if (entry?.taskId !== undefined) return undefined;
    if (!entry) {
      entry = {};
      this.#entries.set(target.contextId, entry);
    }
    clearTimeout(entry.idleTimer);
    entry.taskId = taskId;
    entry.aborted = false;
    const current = entry;
    const run = new PromptRun();
    const outcome = async (): Promise<PromptOutcome> => {
      if (!current.process?.alive) {
        const env = piEnvironment(this.#options, target.caller, target.contextId);
        const prepared = await this.#options.workspaces.prepare(target.contextId, env);
        if (!prepared.ok) return { status: "failed", error: `The context's workspace could not be prepared: ${prepared.error}` };
        if (current.aborted) return { status: "aborted" };
        current.process = this.#start(target, env);
      }
      run.attach(current.process);
      const prompt =
        files.length === 0
          ? text
          : [text, saveToInbox(this.#options.workspaces.dirOf(target.contextId), files)].filter(Boolean).join("\n\n");
      return current.process.prompt(prompt, (question) => run.push({ kind: "question", question }));
    };
    const release = () => {
      current.taskId = undefined;
      if (!current.process?.alive) {
        if (this.#entries.get(target.contextId) === current) this.#entries.delete(target.contextId);
        return;
      }
      current.idleTimer = setTimeout(() => void this.stop(target.contextId), this.#options.idleTimeoutMs);
      current.idleTimer.unref();
    };
    // The context is released before the outcome is reported, so a task sent right after this one is not busy.
    void outcome()
      .catch((error: unknown): PromptOutcome => ({ status: "failed", error: error instanceof Error ? error.message : String(error) }))
      .then((result) => {
        release();
        run.push({ kind: "done", outcome: result });
      });
    return run;
  }

  /** Aborts the task if it is running. Returns whether it was. */
  async abort(taskId: string): Promise<boolean> {
    for (const entry of this.#entries.values()) {
      if (entry.taskId === taskId) {
        entry.aborted = true;
        await entry.process?.abort().catch(() => undefined);
        return true;
      }
    }
    return false;
  }

  /** Stops the context's process, if one is running. The session file stays. */
  async stop(contextId: string): Promise<void> {
    const entry = this.#entries.get(contextId);
    if (!entry) return;
    this.#entries.delete(contextId);
    clearTimeout(entry.idleTimer);
    await entry.process?.stop();
  }

  async close(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((contextId) => this.stop(contextId)));
  }

  #start(target: SessionTarget, env: NodeJS.ProcessEnv): PiRpcProcess {
    const process_ = new PiRpcProcess({
      command: this.#options.piCommand,
      sessionPath: target.sessionPath,
      cwd: this.#options.workspaces.dirOf(target.contextId),
      env,
      logPrefix: `[pi ${target.contextId.slice(0, 8)}]`,
    });
    void process_.exited.then((reason) => {
      const entry = this.#entries.get(target.contextId);
      if (entry?.process === process_ && entry.taskId === undefined) {
        clearTimeout(entry.idleTimer);
        this.#entries.delete(target.contextId);
      }
      console.log(`context ${target.contextId}: ${reason}`);
    });
    console.log(`context ${target.contextId}: started pi for ${target.caller}`);
    return process_;
  }
}
