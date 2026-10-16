import { createReadStream, mkdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { DefaultRequestHandler, type User } from "@a2a-js/sdk/server";
import { jsonRpcHandler } from "@a2a-js/sdk/server/express";
import express, { type Request } from "express";

import { agentCardJson, buildAgentCard } from "./agent-card.ts";
import { Artifacts } from "./artifacts.ts";
import { authenticate, type TokenReviewer } from "./auth.ts";
import type { Config } from "./config.ts";
import { PiAgentExecutor } from "./executor.ts";
import { ContextGuardHandler } from "./handler.ts";
import { Replies } from "./reply.ts";
import { PiSessions, piEnvironment } from "./sessions.ts";
import { TaskSlots } from "./slots.ts";
import { openStore } from "./store.ts";
import { ContextWorkspaces } from "./workspace.ts";

export interface HostOptions {
  config: Config;
  tokenReviewer: TokenReviewer;
  /** The clock for context ages. Milliseconds since the epoch. */
  now?: () => number;
}

export interface Host {
  /** Starts serving and resolves with the base URL. */
  listen(port: number, hostname?: string): Promise<string>;
  /**
   * Deletes the session files and records of contexts unused for longer than the retention period, and the images
   * past theirs.
   */
  sweep(): Promise<void>;
  close(): Promise<void>;
}

class Caller implements User {
  readonly #name: string;

  constructor(name: string) {
    this.#name = name;
  }

  get isAuthenticated(): boolean {
    return true;
  }

  get userName(): string {
    return this.#name;
  }
}

/** The generic host: one agent, served over A2A JSON-RPC, each context backed by a pi process in RPC mode. */
export function createHost(options: HostOptions): Host {
  const { config, tokenReviewer } = options;
  const now = options.now ?? Date.now;
  const sessionsDir = join(config.dataDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.workDir, { recursive: true });

  const store = openStore(join(config.dataDir, "state.db"));
  const orphaned = store.tasks.failUnfinished("The agent host restarted before the task finished.");
  if (orphaned > 0) console.log(`marked ${orphaned} unfinished task(s) from a previous run as failed`);
  const artifacts = new Artifacts({
    dir: join(config.dataDir, "artifacts"),
    registry: store.artifacts,
    now,
    retentionMs: config.artifactRetentionSeconds * 1000,
  });
  artifacts.discardAll();
  const replies = new Replies(join(config.dataDir, "replies"));
  replies.discardAll();

  const workspaces = new ContextWorkspaces(config.workDir, config.contextWorkspace);
  const sessions = new PiSessions({
    piCommand: config.piCommand,
    agentDir: config.agentDir,
    workspaces,
    idleTimeoutMs: config.idleTimeoutSeconds * 1000,
    passEnv: config.passEnv,
    dataDir: config.dataDir,
  });
  const removeWorkspace = async (contextId: string, caller: string) => {
    const removed = await workspaces.remove(contextId, piEnvironment(config, caller, contextId));
    if (!removed.ok) console.error(`context ${contextId}: removing the workspace failed: ${removed.error}`);
  };
  const slots = new TaskSlots(config.maxConcurrentTasks);
  const executor = new PiAgentExecutor({
    contexts: store.contexts,
    sessions,
    sessionsDir,
    artifacts,
    replies,
    artifactUrl: (id) => new URL(`/artifacts/${id}`, config.publicUrl).href,
    now,
    inputTimeoutMs: config.inputTimeoutSeconds * 1000,
    failTask: (taskId, caller, reason) => store.tasks.fail(taskId, caller, reason),
    slots,
    ...(config.taskTimeLimitSeconds === undefined
      ? {}
      : { timeLimit: { limitMs: config.taskTimeLimitSeconds * 1000, graceMs: config.taskTimeLimitGraceSeconds * 1000 } }),
  });
  const requestHandler = new ContextGuardHandler(
    new DefaultRequestHandler(buildAgentCard(config), store.tasks, executor),
    store.contexts,
    store.tasks,
    now,
  );

  const callers = new WeakMap<Request, string>();
  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => {
    res.type("text/plain").send("ok");
  });
  const card = agentCardJson(config);
  app.get("/.well-known/agent-card.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(card);
  });
  app.use(async (req, res, next) => {
    const result = await authenticate(req.headers.authorization, tokenReviewer, config.allowedCallers);
    if (!result.ok) {
      console.log(`refused ${req.method} ${req.path}: ${result.reason}`);
      if (result.status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="a2a"');
      res.status(result.status).json({ error: result.reason });
      return;
    }
    callers.set(req, result.caller);
    next();
  });
  // The images tasks returned, to the caller that sent the task (ADR 0012).
  app.get("/artifacts/:id", (req, res) => {
    const found = artifacts.open(req.params.id, callers.get(req)!);
    if (!found) {
      res.status(404).json({ error: "artifact not found" });
      return;
    }
    res.setHeader("Content-Type", found.record.mediaType);
    res.setHeader("Content-Length", found.record.size);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    createReadStream(found.path)
      .on("error", (error) => {
        console.error(`artifact ${req.params.id}: reading failed: ${error.message}`);
        res.destroy();
      })
      .pipe(res);
  });
  app.use(
    jsonRpcHandler({
      requestHandler,
      userBuilder: async (req) => new Caller(callers.get(req)!),
    }),
  );

  const sweep = async () => {
    const cutoff = now() - config.sessionRetentionSeconds * 1000;
    for (const context of store.contexts.usedBefore(cutoff)) {
      if (sessions.isBusy(context.contextId)) continue;
      await sessions.stop(context.contextId);
      await removeWorkspace(context.contextId, context.owner);
      rmSync(join(sessionsDir, context.sessionFile), { force: true });
      artifacts.discard(context.contextId);
      replies.discard(context.contextId);
      store.contexts.remove(context.contextId);
      console.log(`context ${context.contextId}: deleted after the retention period`);
    }
    // Workspaces of contexts the host no longer knows, e.g. left behind when the host stopped halfway.
    for (const contextId of workspaces.present()) {
      if (store.contexts.has(contextId) || sessions.isBusy(contextId)) continue;
      await removeWorkspace(contextId, "");
      console.log(`context ${contextId}: removed a workspace left behind`);
    }
    artifacts.sweep();
  };
  const sweepTimer = setInterval(
    () => void sweep().catch((error) => console.error("sweep failed:", error)),
    Math.min(config.sessionRetentionSeconds, config.artifactRetentionSeconds, 3600) * 1000,
  );
  sweepTimer.unref();

  let server: Server | undefined;
  return {
    listen(port, hostname) {
      return new Promise((resolve, reject) => {
        const listening = app.listen(port, hostname ?? "::", (error?: Error) => {
          if (error) return reject(error);
          const address = listening.address() as AddressInfo;
          const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
          resolve(`http://${host}:${address.port}`);
        });
        server = listening;
      });
    },
    sweep,
    async close() {
      clearInterval(sweepTimer);
      if (server) {
        const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
        server.closeAllConnections();
        await closed;
      }
      slots.close();
      await sessions.close();
      store.close();
    },
  };
}
