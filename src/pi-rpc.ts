import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** What became of one prompt. */
export type PromptOutcome =
  | { status: "completed"; text: string }
  | { status: "failed"; error: string }
  | { status: "aborted" };

export interface PiRpcOptions {
  /** The command that starts pi; `--mode rpc --session <file>` is appended. */
  command: readonly string[];
  sessionPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Prefix for pi's stderr lines in the host's log. */
  logPrefix: string;
}

interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface AssistantMessage {
  role: "assistant";
  content?: { type: string; text?: string }[];
  stopReason?: string;
  errorMessage?: string;
}

type RpcEvent = { type: string; message?: { role?: string } } & Record<string, unknown>;

/** A free-form question an extension put to the user (`ctx.ui.input` or `ctx.ui.editor`), waiting for an answer. */
export interface DialogRequest {
  id: string;
  text: string;
}

interface UiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  message?: string;
}

/** Dialogs that take free-form text: these go to the caller. Choices and confirmations are dismissed. */
const QUESTION_METHODS = new Set(["input", "editor"]);
const DIALOG_METHODS = new Set(["input", "editor", "select", "confirm"]);

const STOP_GRACE_MS = 5_000;

/**
 * One `pi --mode rpc` child process: sends commands as JSON lines on stdin and reads responses and events from
 * stdout. Records are split on LF only, as the RPC protocol requires (Node's readline would also split on U+2028).
 */
export class PiRpcProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, (response: RpcResponse) => void>();
  readonly #listeners = new Set<(event: RpcEvent) => void>();
  readonly #exited: Promise<string>;
  #nextId = 1;
  #alive = true;
  /** Where questions go while a prompt runs. Outside a prompt nobody could answer, so they are dismissed. */
  #onQuestion: ((request: DialogRequest) => void) | undefined;

  constructor(options: PiRpcOptions) {
    const [program, ...args] = options.command;
    this.#child = spawn(program!, [...args, "--mode", "rpc", "--session", options.sessionPath], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#exited = new Promise((resolve) => {
      this.#child.once("error", (error) => {
        this.#alive = false;
        resolve(`pi could not be started: ${error.message}`);
      });
      this.#child.once("exit", (code, signal) => {
        this.#alive = false;
        resolve(`pi exited (${signal ?? `code ${code}`})`);
      });
    });
    this.#child.stdin.on("error", () => {
      // A write to a process that has just exited; the exit handler reports it.
    });
    let buffer = "";
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line !== "") this.#receive(line);
      }
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) if (line !== "") process.stderr.write(`${options.logPrefix} ${line}\n`);
    });
  }

  get alive(): boolean {
    return this.#alive;
  }

  /** Resolves with a description of how the process ended. */
  get exited(): Promise<string> {
    return this.#exited;
  }

  /** Sends a command and waits for its response. Rejects if pi exits first. */
  async request(command: Record<string, unknown>): Promise<RpcResponse> {
    if (!this.#alive) throw new Error("pi is not running");
    const id = `host-${this.#nextId++}`;
    const response = new Promise<RpcResponse>((resolve) => this.#pending.set(id, resolve));
    this.#child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    const result = await Promise.race([response, this.#exited.then((reason) => new Error(reason))]);
    this.#pending.delete(id);
    if (result instanceof Error) throw result;
    return result;
  }

  /**
   * Sends a prompt and waits until pi settles (`agent_settled`: no retry, compaction or queued message remains).
   * The outcome comes from the last assistant message of the run. A prompt pi handles as a command fails at once.
   */
  async prompt(message: string, onQuestion?: (request: DialogRequest) => void): Promise<PromptOutcome> {
    let last: AssistantMessage | undefined;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const listener = (event: RpcEvent) => {
      if (event.type === "message_end" && event.message?.role === "assistant") last = event.message as AssistantMessage;
      if (event.type === "agent_settled") settle();
    };
    this.#listeners.add(listener);
    this.#onQuestion = onQuestion;
    try {
      const response = await this.request({ type: "prompt", message });
      if (!response.success) return { status: "failed", error: response.error ?? "pi refused the prompt" };
      // An extension command (`/mcp`, say) is handled by pi itself: no run starts, so nothing would settle.
      if ((response.data as { disposition?: string } | undefined)?.disposition === "handled") {
        return { status: "failed", error: "pi took the message as a command and did not start a run" };
      }
      const ended = await Promise.race([settled.then(() => undefined), this.#exited]);
      if (ended !== undefined) return { status: "failed", error: ended };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.#listeners.delete(listener);
      this.#onQuestion = undefined;
    }
    if (!last) return { status: "failed", error: "pi finished without a reply" };
    if (last.stopReason === "aborted") return { status: "aborted" };
    if (last.stopReason === "error") return { status: "failed", error: last.errorMessage ?? "the model call failed" };
    const text = (last.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    return { status: "completed", text };
  }

  /** Answers a dialog, or dismisses it when there is no answer. */
  respondDialog(id: string, answer: string | undefined): void {
    if (!this.#alive) return;
    const response = answer === undefined ? { cancelled: true } : { value: answer };
    this.#child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...response })}\n`);
  }

  /**
   * Tells the running prompt something: pi delivers it after the current turn's tool calls, before the next call of
   * the model.
   */
  async steer(message: string): Promise<void> {
    const response = await this.request({ type: "steer", message });
    if (!response.success) throw new Error(response.error ?? "pi refused the steering message");
  }

  /** Asks pi to abort the running prompt. The prompt then settles as aborted. */
  async abort(): Promise<void> {
    await this.request({ type: "abort" });
  }

  /** Closes stdin, which ends RPC mode, and escalates to signals if pi does not exit. */
  async stop(): Promise<void> {
    if (!this.#alive) return;
    this.#child.stdin.end();
    const timeout = (ms: number) => new Promise<"timeout">((resolve) => setTimeout(resolve, ms, "timeout").unref());
    if ((await Promise.race([this.#exited, timeout(STOP_GRACE_MS)])) !== "timeout") return;
    this.#child.kill("SIGTERM");
    if ((await Promise.race([this.#exited, timeout(STOP_GRACE_MS)])) !== "timeout") return;
    this.#child.kill("SIGKILL");
    await this.#exited;
  }

  #receive(line: string): void {
    let record: RpcEvent | RpcResponse;
    try {
      record = JSON.parse(line) as RpcEvent | RpcResponse;
    } catch {
      return;
    }
    if (record.type === "response") {
      const response = record as RpcResponse;
      if (response.id !== undefined) this.#pending.get(response.id)?.(response);
      return;
    }
    if (record.type === "extension_ui_request") {
      this.#dialog(record as unknown as UiRequest);
      return;
    }
    for (const listener of this.#listeners) listener(record as RpcEvent);
  }

  #dialog(request: UiRequest): void {
    // Notifications, status and widgets need no response; there is no screen to show them on.
    if (!DIALOG_METHODS.has(request.method)) return;
    if (QUESTION_METHODS.has(request.method) && this.#onQuestion) {
      const text = [request.title, request.message].filter((part) => part !== undefined && part !== "").join("\n\n");
      this.#onQuestion({ id: request.id, text });
      return;
    }
    this.respondDialog(request.id, undefined);
  }
}
