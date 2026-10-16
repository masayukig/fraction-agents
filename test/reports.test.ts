import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { reportMarkdown, Reports, reportTitle, type ReportRecord } from "../src/reports.ts";

const OWNER = "system:serviceaccount:fraction-agents:owner";
const CLAUDE = "system:serviceaccount:fraction-agents:claude";

function dir(): string {
  return join(mkdtempSync(join(tmpdir(), "fraction-agents-reports-")), "reports");
}

function record(overrides: Partial<ReportRecord> = {}): ReportRecord {
  return {
    id: crypto.randomUUID(),
    owner: OWNER,
    contextId: crypto.randomUUID(),
    title: "A survey",
    createdAt: Date.parse("2026-10-16T01:00:00Z"),
    partial: false,
    ...overrides,
  };
}

describe("reports", () => {
  it("keeps a report as its Markdown and its record, and reads it back", () => {
    const where = dir();
    const reports = new Reports(where);
    const saved = record();
    reports.save(saved, "# Survey\n\nBody.");
    assert.deepEqual(readdirSync(where).sort(), [`${saved.id}.json`, `${saved.id}.md`]);
    assert.deepEqual(reports.get(saved.id, OWNER), saved);
    assert.equal(reports.markdown(saved.id, OWNER), "# Survey\n\nBody.");
    assert.deepEqual(new Reports(where).get(saved.id, OWNER), saved, "a new instance reads the directory");
  });

  it("lists the owner's reports, newest first, and all of them without an owner", () => {
    const reports = new Reports(dir());
    const old = record({ createdAt: 1000 });
    const recent = record({ createdAt: 3000 });
    const other = record({ owner: CLAUDE, createdAt: 2000 });
    for (const each of [old, other, recent]) reports.save(each, "body");
    assert.deepEqual(
      reports.list(OWNER).map((each) => each.id),
      [recent.id, old.id],
    );
    assert.deepEqual(
      reports.list().map((each) => each.id),
      [recent.id, other.id, old.id],
    );
  });

  it("does not show one owner's report to another", () => {
    const reports = new Reports(dir());
    const saved = record();
    reports.save(saved, "body");
    assert.equal(reports.get(saved.id, CLAUDE), undefined);
    assert.equal(reports.markdown(saved.id, CLAUDE), undefined);
    assert.equal(reports.delete(saved.id, CLAUDE), false);
    assert.ok(reports.get(saved.id, OWNER));
  });

  it("deletes the owner's report, Markdown and record", () => {
    const where = dir();
    const reports = new Reports(where);
    const saved = record();
    reports.save(saved, "body");
    assert.equal(reports.delete(saved.id, OWNER), true);
    assert.deepEqual(readdirSync(where), []);
    assert.equal(reports.get(saved.id, OWNER), undefined);
    assert.equal(reports.delete(saved.id, OWNER), false);
  });

  it("deletes any report without an owner, as the command in the Pod does", () => {
    const reports = new Reports(dir());
    const saved = record({ owner: CLAUDE });
    reports.save(saved, "body");
    assert.equal(reports.delete(saved.id), true);
    assert.equal(reports.list().length, 0);
  });

  it("does not see a report whose record is not written yet, nor files left half written", () => {
    const where = dir();
    const reports = new Reports(where);
    const saved = record();
    reports.save(saved, "body");
    const half = crypto.randomUUID();
    writeFileSync(join(where, `${half}.md`), "only the body");
    writeFileSync(join(where, `.${crypto.randomUUID()}.json.tmp`), "{");
    writeFileSync(join(where, "broken.json"), "not json");
    const fresh = new Reports(where);
    assert.deepEqual(
      fresh.list().map((each) => each.id),
      [saved.id],
    );
    assert.equal(fresh.markdown(half, OWNER), undefined);
  });

  it("sees reports deleted by another process", () => {
    const where = dir();
    const reports = new Reports(where);
    const saved = record();
    reports.save(saved, "body");
    assert.equal(reports.list().length, 1);
    assert.equal(new Reports(where).delete(saved.id), true);
    assert.equal(reports.list().length, 0);
    assert.equal(reports.get(saved.id, OWNER), undefined);
  });

  it("answers nothing for an ID that is not a report ID", () => {
    const where = dir();
    const reports = new Reports(where);
    writeFileSync(join(where, "..", "secret.md"), "secret");
    assert.equal(reports.markdown("../secret", OWNER), undefined);
    assert.equal(reports.get("../secret"), undefined);
    assert.equal(reports.delete("../secret"), false);
    assert.equal(existsSync(join(where, "..", "secret.md")), true);
  });

  it("starts from an empty directory that does not exist yet", () => {
    const where = dir();
    rmSync(where, { recursive: true, force: true });
    assert.deepEqual(new Reports(where).list(), []);
  });

  it("writes the files only readable by the host", () => {
    const where = dir();
    const reports = new Reports(where);
    const saved = record();
    reports.save(saved, "body");
    for (const name of [`${saved.id}.json`, `${saved.id}.md`]) assert.equal(statSync(join(where, name)).mode & 0o077, 0, name);
    assert.equal(statSync(where).mode & 0o077, 0);
  });
});

describe("report Markdown and title", () => {
  const reply = {
    summary: "Rust's async ecosystem in 2026.\nTokio leads.",
    sections: [{ title: "Runtimes", body: "Tokio, smol." }],
    sources: [{ title: "Tokio", url: "https://tokio.rs/" }],
  };

  it("is the reply written out", () => {
    assert.equal(
      reportMarkdown(reply, false),
      "Rust's async ecosystem in 2026.\nTokio leads.\n\n## Runtimes\n\nTokio, smol.\n\n## Sources\n\n- [Tokio](https://tokio.rs/)",
    );
  });

  it("starts with a note when the task stopped at its time limit", () => {
    const markdown = reportMarkdown(reply, true);
    assert.match(markdown, /^> .*時間の上限/);
    assert.ok(markdown.endsWith("- [Tokio](https://tokio.rs/)"));
  });

  it("takes the summary's first line as the title, cut when long", () => {
    assert.equal(reportTitle(reply.summary), "Rust's async ecosystem in 2026.");
    const long = reportTitle("あ".repeat(300));
    assert.equal([...long].length, 120);
    assert.ok(long.endsWith("…"));
  });
});
