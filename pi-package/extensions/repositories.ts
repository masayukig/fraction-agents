// Repositories (ADR 0022): the deep researcher reads public GitHub repositories and never runs them. It adds a tool
// that clones a repository into the context's workspace without credentials, and tools that read its history with
// git log, show and blame in fixed shapes. It keeps pi's read, grep, find and ls inside the workspace, and stops
// bash, edit and write. Settings: `repositories.json` in the agent directory.
import { existsSync } from "node:fs";

import { Type } from "typebox";

import { text, type PiApi, type ToolCallEvent, type ToolContext } from "../lib/pi.ts";
import {
  blameArgs,
  checkWorkspacePath,
  cloneRepository,
  defaultRepositoriesConfigPath,
  loadRepositoriesConfig,
  logArgs,
  runHistory,
  showArgs,
  type BlameParams,
  type LogParams,
  type RepositoriesConfig,
  type ShowParams,
} from "../lib/repositories.ts";

/** pi's built-in tools that read files. They may read only inside the context's workspace. */
const READING_TOOLS = ["read", "grep", "find", "ls"];
/** pi's built-in tools that run commands or change files. The agent has none of them (also left out by piCommand). */
const BLOCKED_TOOLS = ["bash", "edit", "write"];

export interface RepositoriesOptions {
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  /** Where to fetch a repository from instead of GitHub. For tests. */
  remote?: (owner: string, repo: string) => string;
  /** The protocols git may use. Only https by default. */
  protocols?: readonly string[];
}

export function createRepositories(options: RepositoriesOptions = {}): (pi: PiApi) => void {
  return (pi) => {
    const env = options.env ?? process.env;
    const path = defaultRepositoriesConfigPath(env);
    if (!path || !existsSync(path)) return;

    // The guards come first and stay on even when the settings are bad: the agent's settings give it pi's reading
    // tools, and without the guard they would read anywhere, the login in the agent directory included.
    pi.on("tool_call", (event: ToolCallEvent, ctx: ToolContext) => {
      if (BLOCKED_TOOLS.includes(event.toolName)) {
        return { block: true, reason: `${event.toolName} is not available here. This agent reads code and never runs or changes it.` };
      }
      if (!READING_TOOLS.includes(event.toolName)) return undefined;
      const value = event.input?.path;
      const reason = checkWorkspacePath(typeof value === "string" ? value : undefined, ctx.cwd);
      return reason === undefined ? undefined : { block: true, reason: `${event.toolName}: ${reason}` };
    });

    let config: RepositoriesConfig;
    try {
      config = loadRepositoriesConfig(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      (options.warn ?? console.error)(`repositories: ${path} is not usable, so the repository tools are off: ${message}`);
      return;
    }
    const protocols = options.protocols;
    // One clone at a time, so that two clones cannot both fit the context's total and then exceed it together.
    let clones: Promise<unknown> = Promise.resolve();

    const repository = Type.String({ description: 'The cloned repository, as "<owner>/<repo>".' });
    const revision = Type.String({ description: "A commit hash, branch or tag, optionally with ~N or ^. Default HEAD." });

    pi.registerTool({
      name: "clone_repository",
      label: "Clone a GitHub repository",
      description:
        "Clone a public GitHub repository (https://github.com/<owner>/<repo>) into this context's workspace, under repos/<owner>/<repo>, to read it. No submodules, no LFS files, symlinks become plain files holding their target. Private repositories cannot be cloned. A repository too large or too slow to clone is refused.",
      promptSnippet: "Clone a public GitHub repository to read its code",
      promptGuidelines: [
        "Clone with clone_repository, then read with read, grep, find and ls under repos/<owner>/<repo>/, and the history with git_log, git_show and git_blame.",
        "The code is only read, never run: nothing can be installed, built, tested or executed. Write what would need running as 未確認.",
      ],
      parameters: Type.Object({
        url: Type.String({ description: "https://github.com/<owner>/<repo>" }),
        ref: Type.Optional(Type.String({ description: "A branch or tag to check out. The default branch when omitted." })),
      }),
      async execute(_id: string, params: { url: string; ref?: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolContext) {
        const job = clones.then(() => cloneRepository({ workspace: ctx.cwd, url: params.url, ref: params.ref, config, remote: options.remote, protocols, signal }));
        clones = job.catch(() => undefined);
        return text(await job);
      },
    });

    pi.registerTool({
      name: "git_log",
      label: "Read a repository's log",
      description:
        "List commits of a cloned repository, newest first: hash, date, author and subject. Optionally of one path, in a range A..B, by date, author or words in the message, with the files each commit changed.",
      promptSnippet: "List the commits of a cloned repository",
      parameters: Type.Object({
        repository,
        revision: Type.Optional(Type.String({ description: "Where to start, or a range A..B. Default HEAD." })),
        path: Type.Optional(Type.String({ description: "Only commits that touch this path, relative to the repository." })),
        maxCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "How many commits. Default 30." })),
        skip: Type.Optional(Type.Integer({ minimum: 0, description: "Skip this many commits first." })),
        since: Type.Optional(Type.String({ description: "Only commits after this date (YYYY-MM-DD)." })),
        until: Type.Optional(Type.String({ description: "Only commits before this date (YYYY-MM-DD)." })),
        author: Type.Optional(Type.String({ description: "Only commits whose author contains this text." })),
        grep: Type.Optional(Type.String({ description: "Only commits whose message contains this text." })),
        files: Type.Optional(Type.Boolean({ description: "Also list the files each commit changed." })),
      }),
      async execute(_id: string, params: LogParams & { repository: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolContext) {
        const { repository: name, ...log } = params;
        return text(await runHistory(ctx.cwd, name, logArgs(log), config, { protocols, signal }));
      },
    });

    pi.registerTool({
      name: "git_show",
      label: "Show a commit or an old file",
      description:
        "Show one commit of a cloned repository (message, changed files and the patch, optionally only of one path), or, with file, that file as it was at the revision.",
      promptSnippet: "Show a commit, or a file at an older revision",
      parameters: Type.Object({
        repository,
        revision,
        path: Type.Optional(Type.String({ description: "Show only the changes to this path." })),
        file: Type.Optional(Type.String({ description: "Show this file as it was at the revision, instead of the commit." })),
      }),
      async execute(_id: string, params: ShowParams & { repository: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolContext) {
        const { repository: name, ...show } = params;
        return text(await runHistory(ctx.cwd, name, showArgs(show), config, { protocols, signal }));
      },
    });

    pi.registerTool({
      name: "git_blame",
      label: "Blame a file",
      description: "Show which commit last changed each line of a file in a cloned repository, optionally of some lines only.",
      promptSnippet: "Show which commit last changed each line of a file",
      parameters: Type.Object({
        repository,
        path: Type.String({ description: "The file, relative to the repository." }),
        revision: Type.Optional(revision),
        startLine: Type.Optional(Type.Integer({ minimum: 1, description: "The first line." })),
        endLine: Type.Optional(Type.Integer({ minimum: 1, description: "The last line." })),
      }),
      async execute(_id: string, params: BlameParams & { repository: string }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolContext) {
        const { repository: name, ...blame } = params;
        return text(await runHistory(ctx.cwd, name, blameArgs(blame), config, { protocols, signal }));
      },
    });
  };
}

export default createRepositories();
