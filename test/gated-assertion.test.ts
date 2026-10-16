import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { AssertionVerifier, audienceOf } from "../src/gated-assertion.ts";

const ISSUER = "https://auth.example.test";
const AUDIENCE = "reports.example.test";
const ALICE = "github:alice";

interface Key {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeKey(kid: string): Key {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "EdDSA" } };
}

function b64(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

/** A JWS in compact form, the way gated signs its assertions (gated ADR 0034). */
function jws(key: Key, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const head = b64({ alg: "EdDSA", typ: "gated-assertion+jwt", kid: key.kid, ...header });
  const body = b64({ iss: ISSUER, sub: ALICE, aud: AUDIENCE, iat: seconds, exp: seconds + 60, ...claims });
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url")}`;
}

/** gated's JWKS endpoint: the keys published, how long they may be cached, and how often it was asked. */
const jwks = {
  keys: [] as Key[],
  cacheControl: "public, max-age=300",
  up: true,
  fetches: 0,
};
let server: Server;
let jwksUrl: string;

before(async () => {
  server = createServer((_req, res) => {
    jwks.fetches++;
    if (!jwks.up) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": jwks.cacheControl });
    res.end(JSON.stringify({ keys: jwks.keys.map((key) => key.jwk) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  jwksUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__gated/jwks.json`;
});

after(() => server.close());

const current = makeKey("key-1");

beforeEach(() => {
  jwks.keys = [current];
  jwks.cacheControl = "public, max-age=300";
  jwks.up = true;
  jwks.fetches = 0;
});

function verifier(clock: { now: number } = { now: Date.now() }): AssertionVerifier {
  return new AssertionVerifier({
    issuer: ISSUER,
    jwksUrl,
    audience: AUDIENCE,
    allowedSubjects: [ALICE, "github:bob"],
    now: () => clock.now,
  });
}

async function status(check: AssertionVerifier, assertion: string | undefined): Promise<number> {
  const result = await check.verify(assertion);
  return result.ok ? 200 : result.status;
}

describe("gated assertion", () => {
  it("accepts an assertion that passes every step, and says whose it is", async () => {
    const result = await verifier().verify(jws(current));
    assert.deepEqual(result, { ok: true, subject: ALICE });
  });

  it("1: refuses a request without an assertion", async () => {
    assert.equal(await status(verifier(), undefined), 401);
    assert.equal(await status(verifier(), ""), 401);
  });

  it("2: refuses what is not a JWS in compact form, or not of the fixed algorithm and type", async () => {
    const check = verifier();
    for (const bad of ["abc", "a.b", "a.b.c.d", "!!.!!.!!", `${b64("not json")}.${b64({})}.${b64("sig")}`]) {
      assert.equal(await status(check, bad), 401, bad);
    }
    assert.equal(await status(check, jws(current, {}, { alg: "none" })), 401);
    assert.equal(await status(check, jws(current, {}, { alg: "HS256" })), 401);
    assert.equal(await status(check, jws(current, {}, { typ: "JWT" })), 401);
    const unsigned = `${b64({ alg: "none", typ: "gated-assertion+jwt", kid: "key-1" })}.${b64({ iss: ISSUER, sub: ALICE, aud: AUDIENCE })}.`;
    assert.equal(await status(check, unsigned), 401);
  });

  it("3: refuses a key that is not in the configured JWKS, and does not take one from the assertion", async () => {
    const stranger = makeKey("key-2");
    assert.equal(await status(verifier(), jws(stranger)), 401);
    assert.equal(await status(verifier(), jws(stranger, {}, { jku: "https://evil.example/jwks.json", jwk: stranger.jwk })), 401);
    assert.equal(await status(verifier(), jws(current, {}, { kid: undefined })), 401);
  });

  it("4: refuses a signature the key does not verify", async () => {
    const forger = makeKey("key-1");
    assert.equal(await status(verifier(), jws(forger)), 401);
    const [head, body] = jws(current).split(".");
    const tampered = `${head}.${b64({ iss: ISSUER, sub: "github:mallory", aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 60 })}.${jws(current).split(".")[2]}`;
    assert.equal(await status(verifier(), tampered), 401);
    assert.ok(body);
    for (const suffix of ["x", "A", "AA"]) assert.equal(await status(verifier(), `${jws(current)}${suffix}`), 401, suffix);
    const valid = jws(current);
    assert.equal(await status(verifier(), valid.slice(0, -1)), 401, "a signature cut short");
  });

  it("5: refuses another issuer", async () => {
    assert.equal(await status(verifier(), jws(current, { iss: "https://auth.example.test:8443" })), 401);
    assert.equal(await status(verifier(), jws(current, { iss: undefined })), 401);
  });

  it("6: refuses an assertion for another host, whatever the request's Host says", async () => {
    assert.equal(await status(verifier(), jws(current, { aud: "shop.example.test" })), 401);
    assert.equal(await status(verifier(), jws(current, { aud: `${AUDIENCE}:443` })), 401);
    assert.equal(await status(verifier(), jws(current, { aud: undefined })), 401);
  });

  it("7: refuses an expired assertion or one issued in the future, allowing 30 seconds of clock skew", async () => {
    const now = Date.now();
    const at = (offsetSeconds: number) => ({ now: now + offsetSeconds * 1000 });
    const token = jws(current, {}, {}, now);
    assert.equal(await status(verifier(at(60 + 29)), token), 200, "within the skew after exp");
    assert.equal(await status(verifier(at(60 + 31)), token), 401, "past exp and the skew");
    assert.equal(await status(verifier(at(-29)), token), 200, "iat within the skew ahead");
    assert.equal(await status(verifier(at(-31)), token), 401, "iat too far ahead");
    assert.equal(await status(verifier(), jws(current, { exp: undefined })), 401);
  });

  it("8: refuses a subject that is not allowed with 403", async () => {
    assert.equal(await status(verifier(), jws(current, { sub: "github:mallory" })), 403);
    assert.equal(await status(verifier(), jws(current, { sub: "github:bob" })), 200);
  });
});

describe("gated JWKS cache", () => {
  it("fetches the keys once and keeps them for as long as the response says", async () => {
    const clock = { now: Date.now() };
    const check = verifier(clock);
    jwks.cacheControl = "public, max-age=60";
    assert.equal(await status(check, jws(current, {}, {}, clock.now)), 200);
    assert.equal(await status(check, jws(current, {}, {}, clock.now)), 200);
    assert.equal(jwks.fetches, 1);
    clock.now += 61_000;
    assert.equal(await status(check, jws(current, {}, {}, clock.now)), 200);
    assert.equal(jwks.fetches, 2);
  });

  it("keeps the keys for at most 5 minutes", async () => {
    const clock = { now: Date.now() };
    const check = verifier(clock);
    jwks.cacheControl = "public, max-age=86400";
    await check.verify(jws(current, {}, {}, clock.now));
    clock.now += 299_000;
    await check.verify(jws(current, {}, {}, clock.now));
    assert.equal(jwks.fetches, 1);
    clock.now += 2_000;
    await check.verify(jws(current, {}, {}, clock.now));
    assert.equal(jwks.fetches, 2);
  });

  it("fetches again once for an unknown key, but not more often than once a minute", async () => {
    const clock = { now: Date.now() };
    const check = verifier(clock);
    await check.verify(jws(current, {}, {}, clock.now));
    const next = makeKey("key-2");
    jwks.keys = [current, next];
    assert.equal(await status(check, jws(next, {}, {}, clock.now)), 401, "too soon after the last fetch");
    assert.equal(jwks.fetches, 1);
    clock.now += 61_000;
    assert.equal(await status(check, jws(next, {}, {}, clock.now)), 200);
    assert.equal(jwks.fetches, 2);
    const stranger = makeKey("key-3");
    assert.equal(await status(check, jws(stranger, {}, {}, clock.now)), 401);
    assert.equal(jwks.fetches, 2, "one fetch for the unknown key, not one per request");
  });

  it("goes on with the cached keys when the JWKS cannot be fetched", async () => {
    const clock = { now: Date.now() };
    const check = verifier(clock);
    assert.equal(await status(check, jws(current, {}, {}, clock.now)), 200);
    jwks.up = false;
    clock.now += 600_000;
    assert.equal(await status(check, jws(current, {}, {}, clock.now)), 200);
    assert.equal(jwks.fetches, 2);
  });

  it("refuses everything while no key could ever be fetched", async () => {
    jwks.up = false;
    assert.equal(await status(verifier(), jws(current)), 401);
  });
});

describe("audience", () => {
  it("is the public URL's host name, in lower case and without the port", () => {
    assert.equal(audienceOf("https://Reports.Example.test:8443/base/"), "reports.example.test");
  });
});
