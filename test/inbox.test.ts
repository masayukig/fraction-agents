import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Role, type Message, type Part } from "@a2a-js/sdk";

import { MAX_FILE_BYTES, MAX_MESSAGE_FILE_BYTES, filesOf, plainName } from "../src/inbox.ts";

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
