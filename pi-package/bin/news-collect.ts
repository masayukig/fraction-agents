// The news agent's collector (ADR 0017), run beside the host in the agent's pod:
//
//   node news-collect.ts --config <news.json>
//
// It takes in every source at once and then every intervalMinutes, into the store the agent's tools read, until
// SIGTERM or SIGINT. It is the store's only writer: run one per store.
import { parseArgs } from "node:util";

import { defaultNewsConfigPath, loadNewsConfig, NewsStore, runCollector } from "../lib/news.ts";

const { values } = parseArgs({ options: { config: { type: "string" } } });
const path = values.config ?? defaultNewsConfigPath();
if (!path) {
  process.stderr.write("usage: news-collect.ts --config <news.json>\n");
  process.exit(2);
}
let config;
try {
  config = loadNewsConfig(path);
} catch (error) {
  process.stderr.write(`news-collect: ${path} is not usable: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`news-collect: ${signal}: stopping`);
    controller.abort();
  });
}
console.log(
  `news-collect: ${config.sources.length} source(s) every ${config.intervalMinutes} minutes into ${config.storeDir}`,
);
await runCollector({
  config,
  store: new NewsStore(config.storeDir),
  signal: controller.signal,
  log: (line) => console.log(line),
});
