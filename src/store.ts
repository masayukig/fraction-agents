import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { Role, Task, TaskState, type ListTasksRequest, type ListTasksResponse } from "@a2a-js/sdk";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import { resolveUserScope, type ServerCallContext, type TaskStore } from "@a2a-js/sdk/server";

import { withoutFileBytes as withoutMessageFileBytes } from "./inbox.ts";

const DEFAULT_PAGE_SIZE = 50;
const UNFINISHED = [TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_INPUT_REQUIRED];

export interface ContextRecord {
  contextId: string;
  owner: string;
  /** The session file's name inside the sessions directory. Chosen by the host, never taken from a request. */
  sessionFile: string;
  /** Milliseconds since the epoch. */
  lastUsedAt: number;
}

/** An image a task returned, kept in the artifacts directory under its ID. */
export interface ArtifactRecord {
  /** Random, and the file's name. Only such IDs are ever used as file names. */
  id: string;
  owner: string;
  taskId: string;
  mediaType: string;
  size: number;
  /** Milliseconds since the epoch. */
  createdAt: number;
}

export interface Store {
  tasks: SqliteTaskStore;
  contexts: ContextRegistry;
  artifacts: ArtifactRegistry;
  close(): void;
}

/** Opens (and creates if needed) the host's SQLite database of tasks, contexts and artifacts. */
export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      owner TEXT NOT NULL,
      id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      state INTEGER NOT NULL,
      status_timestamp TEXT NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (owner, id)
    );
    CREATE INDEX IF NOT EXISTS tasks_by_context ON tasks (context_id);
    CREATE TABLE IF NOT EXISTS contexts (
      context_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      session_file TEXT NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      task_id TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return {
    tasks: new SqliteTaskStore(db),
    contexts: new ContextRegistry(db),
    artifacts: new ArtifactRegistry(db),
    close: () => db.close(),
  };
}

/** A TaskStore that survives restarts. Every task belongs to the caller that created it (ADR 0003). */
export class SqliteTaskStore implements TaskStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO tasks (owner, id, context_id, state, status_timestamp, body) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner, id) DO UPDATE SET
           context_id = excluded.context_id, state = excluded.state,
           status_timestamp = excluded.status_timestamp, body = excluded.body`,
      )
      .run(
        resolveUserScope(context),
        task.id,
        task.contextId,
        task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
        task.status?.timestamp ?? "",
        JSON.stringify(Task.toJSON(withoutFileBytes(task))),
      );
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const row = this.#db
      .prepare("SELECT body FROM tasks WHERE owner = ? AND id = ?")
      .get(resolveUserScope(context), taskId) as { body: string } | undefined;
    return row ? Task.fromJSON(JSON.parse(row.body)) : undefined;
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const where = ["owner = ?"];
    const args: (string | number)[] = [resolveUserScope(context)];
    if (params.contextId) {
      where.push("context_id = ?");
      args.push(params.contextId);
    }
    if (params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
      where.push("state = ?");
      args.push(params.status);
    }
    if (params.statusTimestampAfter) {
      // Compared as instants, the way the SDK's in-memory store does, not as strings.
      where.push("status_timestamp != '' AND julianday(status_timestamp) > julianday(?)");
      args.push(new Date(params.statusTimestampAfter).toISOString());
    }
    const filter = where.join(" AND ");
    const { total } = this.#db.prepare(`SELECT count(*) AS total FROM tasks WHERE ${filter}`).get(...args) as {
      total: number;
    };

    const pageWhere = [...where];
    const pageArgs = [...args];
    if (params.pageToken) {
      const [timestamp, id] = decodeCursor(params.pageToken);
      pageWhere.push("(status_timestamp < ? OR (status_timestamp = ? AND id < ?))");
      pageArgs.push(timestamp, timestamp, id);
    }
    const rows = this.#db
      .prepare(
        `SELECT id, status_timestamp, body FROM tasks WHERE ${pageWhere.join(" AND ")}
         ORDER BY status_timestamp DESC, id DESC LIMIT ?`,
      )
      .all(...pageArgs, pageSize + 1) as { id: string; status_timestamp: string; body: string }[];

    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    return {
      tasks: page.map((row) => {
        const task = Task.fromJSON(JSON.parse(row.body));
        if (!params.includeArtifacts) task.artifacts = [];
        return task;
      }),
      nextPageToken: rows.length > pageSize && last ? encodeCursor(last.status_timestamp, last.id) : "",
      pageSize,
      totalSize: total,
    };
  }

  /**
   * Marks tasks still submitted, working or waiting for input as failed. Called at start-up: no pi process survives
   * the host, so nothing will ever finish them.
   */
  failUnfinished(reason: string): number {
    const rows = this.#db
      .prepare(`SELECT owner, body FROM tasks WHERE state IN (${UNFINISHED.map(() => "?").join(", ")})`)
      .all(...UNFINISHED) as { owner: string; body: string }[];
    for (const row of rows) this.#markFailed(row.owner, Task.fromJSON(JSON.parse(row.body)), reason);
    return rows.length;
  }

  /**
   * Marks one of the owner's unfinished tasks as failed, outside of any running request (for example when a
   * question to the caller times out). Returns whether there was such a task.
   */
  fail(taskId: string, owner: string, reason: string): boolean {
    const row = this.#db
      .prepare(`SELECT body FROM tasks WHERE owner = ? AND id = ? AND state IN (${UNFINISHED.map(() => "?").join(", ")})`)
      .get(owner, taskId, ...UNFINISHED) as { body: string } | undefined;
    if (!row) return false;
    this.#markFailed(owner, Task.fromJSON(JSON.parse(row.body)), reason);
    return true;
  }

  #markFailed(owner: string, task: Task, reason: string): void {
    const timestamp = new Date().toISOString();
    task.status = {
      state: TaskState.TASK_STATE_FAILED,
      timestamp,
      message: {
        messageId: randomUUID(),
        contextId: task.contextId,
        taskId: task.id,
        role: Role.ROLE_AGENT,
        parts: [{ content: { $case: "text", value: reason }, metadata: {}, filename: "", mediaType: "text/plain" }],
        metadata: {},
        extensions: [],
        referenceTaskIds: [],
      },
    };
    this.#db
      .prepare("UPDATE tasks SET state = ?, status_timestamp = ?, body = ? WHERE owner = ? AND id = ?")
      .run(TaskState.TASK_STATE_FAILED, timestamp, JSON.stringify(Task.toJSON(task)), owner, task.id);
  }
}

/** The task without the bytes of the files callers sent (ADR 0023). */
function withoutFileBytes(task: Task): Task {
  return { ...task, history: task.history.map(withoutMessageFileBytes) };
}

/** Which caller owns which context, and which session file holds its conversation. */
export class ContextRegistry {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Numbers a new context for the caller. The session file's name is a separate random value. */
  create(owner: string, now: number): Omit<ContextRecord, "owner" | "lastUsedAt"> {
    const record = { contextId: randomUUID(), sessionFile: `${randomUUID()}.jsonl` };
    this.#db
      .prepare("INSERT INTO contexts (context_id, owner, session_file, last_used_at) VALUES (?, ?, ?, ?)")
      .run(record.contextId, owner, record.sessionFile, now);
    return record;
  }

  /** The context, if it exists and belongs to the caller. Someone else's context is indistinguishable from none. */
  get(contextId: string, owner: string): ContextRecord | undefined {
    const row = this.#db
      .prepare("SELECT context_id, owner, session_file, last_used_at FROM contexts WHERE context_id = ? AND owner = ?")
      .get(contextId, owner) as ContextRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Whether the context exists, whoever owns it. */
  has(contextId: string): boolean {
    return this.#db.prepare("SELECT 1 FROM contexts WHERE context_id = ?").get(contextId) !== undefined;
  }

  touch(contextId: string, now: number): void {
    this.#db.prepare("UPDATE contexts SET last_used_at = ? WHERE context_id = ?").run(now, contextId);
  }

  usedBefore(cutoff: number): ContextRecord[] {
    const rows = this.#db
      .prepare("SELECT context_id, owner, session_file, last_used_at FROM contexts WHERE last_used_at < ?")
      .all(cutoff) as unknown as ContextRow[];
    return rows.map(fromRow);
  }

  /** Forgets the context and its tasks. */
  remove(contextId: string): void {
    this.#db.prepare("DELETE FROM tasks WHERE context_id = ?").run(contextId);
    this.#db.prepare("DELETE FROM contexts WHERE context_id = ?").run(contextId);
  }
}

/** Which caller each stored artifact belongs to, and what it is. */
export class ArtifactRegistry {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  add(record: ArtifactRecord): void {
    this.#db
      .prepare("INSERT INTO artifacts (id, owner, task_id, media_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(record.id, record.owner, record.taskId, record.mediaType, record.size, record.createdAt);
  }

  /** The artifact, if it exists and belongs to the caller. Someone else's artifact is indistinguishable from none. */
  get(id: string, owner: string): ArtifactRecord | undefined {
    const row = this.#db
      .prepare("SELECT id, owner, task_id, media_type, size, created_at FROM artifacts WHERE id = ? AND owner = ?")
      .get(id, owner) as ArtifactRow | undefined;
    return row ? artifactFromRow(row) : undefined;
  }

  createdBefore(cutoff: number): ArtifactRecord[] {
    const rows = this.#db
      .prepare("SELECT id, owner, task_id, media_type, size, created_at FROM artifacts WHERE created_at < ?")
      .all(cutoff) as unknown as ArtifactRow[];
    return rows.map(artifactFromRow);
  }

  remove(id: string): void {
    this.#db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
  }
}

interface ArtifactRow {
  id: string;
  owner: string;
  task_id: string;
  media_type: string;
  size: number;
  created_at: number;
}

function artifactFromRow(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    owner: row.owner,
    taskId: row.task_id,
    mediaType: row.media_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

interface ContextRow {
  context_id: string;
  owner: string;
  session_file: string;
  last_used_at: number;
}

function fromRow(row: ContextRow): ContextRecord {
  return { contextId: row.context_id, owner: row.owner, sessionFile: row.session_file, lastUsedAt: row.last_used_at };
}

function encodeCursor(timestamp: string, id: string): string {
  return Buffer.from(JSON.stringify([timestamp, id])).toString("base64url");
}

function decodeCursor(token: string): [string, string] {
  try {
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "string")) {
      return value as [string, string];
    }
  } catch {
    // Falls through to the error below.
  }
  throw new RequestMalformedError("pageToken is not valid");
}
