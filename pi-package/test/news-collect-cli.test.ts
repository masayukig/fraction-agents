import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { NewsStore } from "../lib/news.ts";

const CLI = resolve(import.meta.dirname, "../bin/news-collect.ts");

function run(args: string[]) {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  return { child, exited, output: () => output };
}

describe("news-collect command", () => {
  it("takes in at once, keeps running, and stops cleanly on SIGTERM", async () => {
    // A feed served on the loopback address: the test never leaves the machine.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end('<rss><channel><item><title>Local</title><link>https://news.example/local</link></item></channel></rss>');
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const dir = mkdtempSync(join(tmpdir(), "news-cli-"));
      const storeDir = join(dir, "news");
      const config = join(dir, "news.json");
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed.xml`;
      writeFileSync(config, JSON.stringify({ storeDir, sources: [{ name: "Local", kind: "feed", url }] }));
      const { child, exited, output } = run(["--config", config]);
      const store = new NewsStore(storeDir);
      for (let i = 0; i < 100 && store.sources().Local === undefined; i++) await new Promise((done) => setTimeout(done, 50));
      assert.equal(store.all()[0]?.title, "Local");
      assert.equal(child.exitCode, null, "it waits for the next round");
      child.kill("SIGTERM");
      assert.equal(await exited, 0);
      assert.match(output(), /took in 1 new article/);
    } finally {
      server.close();
    }
  });

  it("refuses settings it cannot use", async () => {
    const dir = mkdtempSync(join(tmpdir(), "news-cli-"));
    const config = join(dir, "news.json");
    writeFileSync(config, JSON.stringify({ sources: [] }));
    const { exited, output } = run(["--config", config]);
    assert.equal(await exited, 1);
    assert.match(output(), /at least one source/);
  });
});
