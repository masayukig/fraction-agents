import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderReply, type Reply } from "./reply.ts";

/** What the host records of a report, next to its Markdown (ADR 0020). */
export interface ReportRecord {
  /** The taskId of the task that returned it. */
  id: string;
  /** The caller that sent the task: the ServiceAccount's full name. */
  owner: string;
  contextId: string;
  title: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** Whether the task stopped at its time limit and returned the work so far. */
  partial: boolean;
}

/** The note at the top of a report the task returned at its time limit. Fixed: the host's words. */
export const PARTIAL_NOTE =
  "> **注記:** この依頼は時間の上限に来たため、ここまでの結果を返しています。同じ context で「続けて」と頼むと、続きから調べられます。";

const TITLE_LIMIT = 120;
const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether the value can be a report ID. Only such IDs are ever used as file names. */
export function isReportId(value: string): boolean {
  return REPORT_ID.test(value);
}

/** The report of a reply: the reply written out, with a note at the top when the task returned the work so far. */
export function reportMarkdown(reply: Reply, partial: boolean): string {
  const markdown = renderReply(reply);
  return partial ? `${PARTIAL_NOTE}\n\n${markdown}` : markdown;
}

/** The title of a report: the first line of the reply's summary, cut when long. */
export function reportTitle(summary: string): string {
  const line = [...(summary.split("\n")[0] ?? "").trim()];
  return line.length <= TITLE_LIMIT ? line.join("") : `${line.slice(0, TITLE_LIMIT - 1).join("")}…`;
}

/**
 * The reports in their directory (ADR 0020). Each is two files: `<id>.md`, the body, and `<id>.json`, the record.
 * Both are written to a temporary file and renamed into place, the body first; only a report with a record exists,
 * so a report being written is never seen. The records are read once and kept; the directory is listed on each
 * look-up, so that a report deleted by the command in the Pod is gone here too.
 */
export class Reports {
  readonly #dir: string;
  #records: Map<string, ReportRecord> | undefined;

  constructor(dir: string) {
    this.#dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  save(record: ReportRecord, markdown: string): void {
    if (!isReportId(record.id)) throw new Error(`not a report ID: ${JSON.stringify(record.id)}`);
    this.#write(`${record.id}.md`, markdown);
    this.#write(`${record.id}.json`, JSON.stringify(record));
    this.#records?.set(record.id, record);
  }

  /** The reports of the owner, or every report without an owner, newest first. */
  list(owner?: string): ReportRecord[] {
    return [...this.#read().values()]
      .filter((record) => owner === undefined || record.owner === owner)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  }

  /** The report, if it exists and belongs to the owner (any owner when not given). Another's is the same as none. */
  get(id: string, owner?: string): ReportRecord | undefined {
    if (!isReportId(id)) return undefined;
    const record = this.#read().get(id);
    return record && (owner === undefined || record.owner === owner) ? record : undefined;
  }

  /** The report's Markdown, on the same terms as {@link get}. */
  markdown(id: string, owner?: string): string | undefined {
    if (!this.get(id, owner)) return undefined;
    try {
      return readFileSync(join(this.#dir, `${id}.md`), "utf8");
    } catch {
      return undefined;
    }
  }

  /** Deletes the report, on the same terms as {@link get}. Returns whether there was one. */
  delete(id: string, owner?: string): boolean {
    if (!this.get(id, owner)) return false;
    // The record first: without it the report is gone, even if removing the body fails.
    rmSync(join(this.#dir, `${id}.json`), { force: true });
    rmSync(join(this.#dir, `${id}.md`), { force: true });
    this.#records?.delete(id);
    return true;
  }

  #write(name: string, content: string): void {
    const temporary = join(this.#dir, `.${randomUUID()}.tmp`);
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, join(this.#dir, name));
  }

  #read(): Map<string, ReportRecord> {
    let names: string[];
    try {
      names = readdirSync(this.#dir);
    } catch {
      return new Map();
    }
    const known = this.#records ?? new Map<string, ReportRecord>();
    const records = new Map<string, ReportRecord>();
    for (const name of names) {
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
      if (!isReportId(id)) continue;
      const record = known.get(id) ?? parseRecord(this.#dir, name);
      if (record?.id === id) records.set(id, record);
    }
    this.#records = records;
    return records;
  }
}

function parseRecord(dir: string, name: string): ReportRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<ReportRecord>;
    if (
      typeof value.id === "string" &&
      typeof value.owner === "string" &&
      typeof value.contextId === "string" &&
      typeof value.title === "string" &&
      typeof value.createdAt === "number" &&
      typeof value.partial === "boolean"
    ) {
      return {
        id: value.id,
        owner: value.owner,
        contextId: value.contextId,
        title: value.title,
        createdAt: value.createdAt,
        partial: value.partial,
      };
    }
  } catch {
    // An unreadable record is no report.
  }
  console.error(`reports: left out ${name}: not a report record`);
  return undefined;
}
