// The reports of an agent, for the owner of the cluster (ADR 0020): run in the agent's Pod with `kubectl exec`.
// It reads the same config as the host and works on the reports directory directly, whoever owns the reports.
//
//   node /app/dist/src/report-cli.js list
//   node /app/dist/src/report-cli.js delete <id>
import { parseArgs } from "node:util";

import { loadConfig } from "./config.ts";
import { callerName } from "./report-html.ts";
import { Reports } from "./reports.ts";

const DEFAULT_CONFIG = "/etc/fraction-agents/config.json";
const USAGE = "usage: report-cli [--config <file>] list | delete <id>";

function main(): number {
  let parsed;
  try {
    parsed = parseArgs({ options: { config: { type: "string" } }, allowPositionals: true });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const [command, id, ...rest] = parsed.positionals;
  const valid = (command === "list" && id === undefined) || (command === "delete" && id !== undefined && rest.length === 0);
  if (!valid) {
    console.error(USAGE);
    return 2;
  }
  const path = parsed.values.config ?? process.env.FRACTION_AGENTS_CONFIG ?? DEFAULT_CONFIG;
  let config;
  try {
    config = loadConfig(path);
  } catch (error) {
    console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!config.reports) {
    console.error("this agent keeps no reports: the config has no reports");
    return 1;
  }
  const reports = new Reports(config.reports.dir);
  if (command === "list") {
    // One line per report, tab-separated: ID, time (TZ), caller, "partial" or empty, title.
    for (const record of reports.list()) {
      const time = new Date(record.createdAt).toLocaleString("sv-SE", { timeZoneName: "short" });
      const title = record.title.replace(/[\t\r\n]+/g, " ");
      console.log([record.id, time, callerName(record.owner), record.partial ? "partial" : "", title].join("\t"));
    }
    return 0;
  }
  if (!reports.delete(id!)) {
    console.error(`report not found: ${id}`);
    return 1;
  }
  console.log(`deleted ${id}`);
  return 0;
}

process.exitCode = main();
