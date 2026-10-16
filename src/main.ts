import { parseArgs } from "node:util";

import { KubernetesTokenReviewer } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { createHost } from "./host.ts";

const DEFAULT_CONFIG = "/etc/fraction-agents/config.json";

const { values } = parseArgs({ options: { config: { type: "string" } } });
const config = loadConfig(values.config ?? process.env.FRACTION_AGENTS_CONFIG ?? DEFAULT_CONFIG);
const host = createHost({ config, tokenReviewer: KubernetesTokenReviewer.inCluster() });
const url = await host.listen(config.port);
console.log(`${config.name}: listening on ${url}, advertised as ${config.publicUrl}`);
if (config.reports?.web) {
  const web = await host.listenWeb(config.reports.web.port);
  console.log(`${config.name}: serving the report pages on ${web}, published as ${config.reports.web.publicUrl}`);
}

let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: shutting down`);
    host.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("shutdown failed:", error);
        process.exit(1);
      },
    );
  });
}
