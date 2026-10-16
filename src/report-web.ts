import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import express, { type Express, type Response } from "express";

import { ASSERTION_HEADER, type AssertionVerifier } from "./gated-assertion.ts";
import { renderReportHtml, renderReportList, WEB_POLICY } from "./report-html.ts";
import type { Reports } from "./reports.ts";

/**
 * The script that draws the diagrams on a report page, in Mermaid's strictest setting: no HTML from the diagram's
 * text, no click handlers. Served from `/assets/`, since the pages allow no inline script.
 */
export const REPORT_SCRIPT = `"use strict";
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
});
mermaid.run({ querySelector: "pre.mermaid" });
`;

/**
 * Mermaid's browser bundle. The image carries it next to the host's code (`dist/assets`); in a checkout it comes
 * from the dev dependency.
 */
function mermaidBundle(): string {
  const bundled = join(import.meta.dirname, "..", "assets", "mermaid.min.js");
  if (existsSync(bundled)) return bundled;
  return createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js");
}

export interface ReportWebOptions {
  reports: Reports;
  verifier: AssertionVerifier;
}

/**
 * The pages people read the reports on (ADR 0021): a listener of its own, behind gated. Every request is checked
 * against gated's assertion before anything is served; the pages are read-only and show every caller's reports.
 */
export function reportWebApp(options: ReportWebOptions): Express {
  const { reports, verifier } = options;
  const mermaid = mermaidBundle();
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", WEB_POLICY);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      res.status(405).type("text/plain").send("Method Not Allowed");
      return;
    }
    next();
  });
  app.use(async (req, res, next) => {
    const result = await verifier.verify(req.get(ASSERTION_HEADER));
    if (!result.ok) {
      console.log(`report pages: refused ${req.method} ${req.path}: ${result.reason}`);
      res.status(result.status).type("text/plain").send(result.status === 401 ? "Unauthorized" : "Forbidden");
      return;
    }
    next();
  });
  app.get("/", (_req, res) => {
    html(res, renderReportList(reports.list()));
  });
  app.get("/reports/:name", (req, res) => {
    const match = /^([^.]+)(\.md)?$/.exec(req.params.name);
    const record = match ? reports.get(match[1]!) : undefined;
    const markdown = record ? reports.markdown(record.id) : undefined;
    if (!record || markdown === undefined) {
      notFound(res);
      return;
    }
    if (match![2]) res.type("text/markdown; charset=utf-8").send(markdown);
    else html(res, renderReportHtml(record, markdown, { web: true }));
  });
  app.get("/assets/report.js", (_req, res) => {
    res.type("text/javascript; charset=utf-8").send(REPORT_SCRIPT);
  });
  app.get("/assets/mermaid.min.js", (_req, res) => {
    res.type("text/javascript; charset=utf-8").sendFile(mermaid, { cacheControl: false, lastModified: false, dotfiles: "allow" });
  });
  app.use((_req, res) => notFound(res));
  return app;
}

function html(res: Response, body: string): void {
  res.type("text/html; charset=utf-8").send(body);
}

function notFound(res: Response): void {
  res.status(404).type("text/plain").send("Not Found");
}
