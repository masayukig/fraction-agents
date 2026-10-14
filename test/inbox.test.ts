import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Message as MessageJson, Role, type Message, type Part } from "@a2a-js/sdk";

import { MAX_FILE_BYTES, MAX_MESSAGE_FILE_BYTES, MAX_REQUEST_BYTES, filesOf, plainName, saveToInbox } from "../src/inbox.ts";

function message(parts: Part[]): Message {
  return { messageId: "m", contextId: "", taskId: "", role: Role.ROLE_USER, parts, metadata: {}, extensions: [], referenceTaskIds: [] };
}

function file(size: number, filename = "a.bin"): Part {
  return { content: { $case: "raw", value: Buffer.alloc(size) }, metadata: {}, filename, mediaType: "application/octet-stream" };
}

describe("files of a message", () => {
  it("takes up to 20 MiB a file", () => {
    assert.equal((filesOf(message([file(MAX_FILE_BYTES)])) as unknown[]).length, 1);
    assert.match(filesOf(message([file(MAX_FILE_BYTES + 1, "big.pdf")])) as string, /^big\.pdf is over \d+ bytes/);
  });

  it("takes up to 50 MiB in all", () => {
    const parts = [file(MAX_FILE_BYTES), file(MAX_FILE_BYTES), file(MAX_MESSAGE_FILE_BYTES - 2 * MAX_FILE_BYTES)];
    assert.equal((filesOf(message(parts)) as unknown[]).length, 3);
    assert.match(filesOf(message([...parts, file(1)])) as string, /in total/);
  });
});

describe("the request limit", () => {
  it("lets through a request with 8 files of 50 MiB in all and a long text", () => {
    const sizes = [MAX_FILE_BYTES, MAX_FILE_BYTES, ...Array.from({ length: 6 }, () => (MAX_MESSAGE_FILE_BYTES - 2 * MAX_FILE_BYTES) / 6)];
    const parts = [
      { content: { $case: "text" as const, value: "x".repeat(100_000) }, metadata: {}, filename: "", mediaType: "text/plain" },
      ...sizes.map((size, index) => file(Math.floor(size), `${"n".repeat(200)}-${index}.pdf`)),
    ];
    assert.equal((filesOf(message(parts)) as unknown[]).length, 8);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "a".repeat(100),
      method: "SendMessage",
      params: { message: MessageJson.toJSON(message(parts)), configuration: { returnImmediately: true } },
    });
    assert.ok(Buffer.byteLength(body) <= MAX_REQUEST_BYTES, `${Buffer.byteLength(body)} > ${MAX_REQUEST_BYTES}`);
  });
});

describe("saving in the inbox", () => {
  it("removes the files it wrote when one cannot be written", () => {
    const dir = mkdtempSync(join(tmpdir(), "fraction-agents-inbox-"));
    const bad = { filename: "b.txt", mediaType: "text/plain", bytes: { length: 1 } as unknown as Buffer };
    assert.throws(() => saveToInbox(dir, [{ filename: "a.txt", mediaType: "text/plain", bytes: Buffer.from("a") }, bad]));
    assert.deepEqual(readdirSync(join(dir, "inbox")), []);
  });
});

describe("plain names", () => {
  const cases: Record<string, string> = {
    "report.pdf": "report.pdf",
    "../../etc/passwd": "passwd",
    "..\\windows\\a.txt": "a.txt",
    ".bashrc": "bashrc",
    "-rf": "rf",
    "..": "file",
    "": "file",
    "見積 書（第2版）.pdf": "見積_書_第2版_.pdf",
    "a$(rm -rf ~).sh": "a_rm_-rf_.sh",
    [`${"x".repeat(200)}.tar`]: `${"x".repeat(60)}.tar`,
  };
  for (const [given, expected] of Object.entries(cases)) {
    it(`${JSON.stringify(given.slice(0, 30))} → ${expected.slice(0, 30)}`, () => assert.equal(plainName(given), expected));
  }
});
