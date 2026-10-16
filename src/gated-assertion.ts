import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * Checks the `Gated-Assertion` header gated puts on the requests of a logged-in subject (gated ADR 0034), in the
 * eight steps of fraction-agents ADR 0021. Steps 1 to 7 establish that gated authenticated the subject for this
 * host; step 8 is whether this host lets the subject in. Written on Node's own crypto: the algorithm is fixed to
 * EdDSA (Ed25519), so a JOSE library would add little but a dependency.
 */

export const ASSERTION_HEADER = "gated-assertion";

const ALGORITHM = "EdDSA";
const TYPE = "gated-assertion+jwt";
const CLOCK_SKEW_MS = 30_000;
/** The keys are fetched again after at most this long, whatever the response says. */
const MAX_CACHE_MS = 300_000;
/** An unknown key fetches the keys again only if the last fetch is at least this old. */
const REFETCH_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface AssertionVerifierOptions {
  /** gated's central authentication host, as an origin. */
  issuer: string;
  /** Where gated publishes its keys. Never taken from an assertion. */
  jwksUrl: string;
  /** This host's public host name, compared with `aud`. Not the request's `Host` header. */
  audience: string;
  allowedSubjects: readonly string[];
  now?: () => number;
}

export type AssertionResult = { ok: true; subject: string } | { ok: false; status: 401 | 403; reason: string };

/** The audience of a public URL: its host name in lower case, without the port. */
export function audienceOf(publicUrl: string): string {
  return new URL(publicUrl).hostname.toLowerCase();
}

export class AssertionVerifier {
  readonly #options: AssertionVerifierOptions;
  readonly #now: () => number;
  #keys = new Map<string, KeyObject>();
  #fetchedAt: number | undefined;
  #expiresAt = 0;
  #fetching: Promise<void> | undefined;

  constructor(options: AssertionVerifierOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async verify(assertion: string | undefined): Promise<AssertionResult> {
    // 1. There is an assertion.
    if (assertion === undefined || assertion === "") return refuse(401, "no assertion");
    // 2. A JWS in compact form, of the algorithm and type fixed here.
    const parts = assertion.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return refuse(401, "not a compact JWS");
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = decodeJson(encodedHeader);
    const payload = decodeJson(encodedPayload);
    if (!header || !payload) return refuse(401, "not a compact JWS");
    if (header.alg !== ALGORITHM) return refuse(401, `algorithm ${JSON.stringify(header.alg)} is not ${ALGORITHM}`);
    if (header.typ !== TYPE) return refuse(401, `type ${JSON.stringify(header.typ)} is not ${TYPE}`);
    // 3. The key is in the configured JWKS.
    if (typeof header.kid !== "string" || header.kid === "") return refuse(401, "no key ID");
    const key = await this.#key(header.kid);
    if (!key) return refuse(401, `unknown key ${JSON.stringify(header.kid)}`);
    // 4. The key verifies the signature.
    const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`);
    const signature = Buffer.from(encodedSignature, "base64url");
    // Only the one encoding of a 64-byte signature: decoding alone would let trailing characters through.
    if (signature.length !== 64 || signature.toString("base64url") !== encodedSignature || !verify(null, signed, key, signature)) {
      return refuse(401, "bad signature");
    }
    // 5. The issuer is the configured one.
    if (payload.iss !== this.#options.issuer) return refuse(401, `issuer ${JSON.stringify(payload.iss)} is not accepted`);
    // 6. The audience is this host.
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(this.#options.audience)) return refuse(401, `audience ${JSON.stringify(payload.aud)} is not this host`);
    // 7. Not expired, and not issued too far in the future.
    const now = this.#now();
    if (typeof payload.exp !== "number" || payload.exp * 1000 + CLOCK_SKEW_MS < now) return refuse(401, "expired");
    if (typeof payload.iat !== "number" || payload.iat * 1000 - CLOCK_SKEW_MS > now) return refuse(401, "issued in the future");
    // 8. The subject is allowed here.
    if (typeof payload.sub !== "string" || !this.#options.allowedSubjects.includes(payload.sub)) {
      return refuse(403, `subject ${JSON.stringify(payload.sub)} is not allowed`);
    }
    return { ok: true, subject: payload.sub };
  }

  /**
   * The public key of the ID. The keys are fetched when the cache has expired, and once more for an unknown ID if
   * the last fetch is a minute old or more. When they cannot be fetched, the cached keys go on being used.
   */
  async #key(kid: string): Promise<KeyObject | undefined> {
    const now = this.#now();
    if (this.#fetchedAt === undefined || now >= this.#expiresAt) await this.#refresh();
    else if (!this.#keys.has(kid) && now - this.#fetchedAt >= REFETCH_INTERVAL_MS) await this.#refresh();
    return this.#keys.get(kid);
  }

  #refresh(): Promise<void> {
    this.#fetching ??= this.#fetch().finally(() => (this.#fetching = undefined));
    return this.#fetching;
  }

  async #fetch(): Promise<void> {
    const startedAt = this.#now();
    try {
      const response = await fetch(this.#options.jwksUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { keys?: unknown };
      if (!Array.isArray(body.keys)) throw new Error("no keys");
      const keys = new Map<string, KeyObject>();
      for (const jwk of body.keys) {
        const key = publicKey(jwk);
        if (key) keys.set(key.kid, key.key);
      }
      this.#keys = keys;
      this.#expiresAt = startedAt + Math.min(maxAge(response.headers.get("cache-control")) ?? MAX_CACHE_MS, MAX_CACHE_MS);
    } catch (error) {
      console.error(`gated JWKS: fetching ${this.#options.jwksUrl} failed: ${error instanceof Error ? error.message : String(error)}`);
      // The cached keys stay, and the fetch is tried again a minute later, not on every request meanwhile.
      this.#expiresAt = startedAt + REFETCH_INTERVAL_MS;
    } finally {
      this.#fetchedAt = startedAt;
    }
  }
}

function refuse(status: 401 | 403, reason: string): AssertionResult {
  return { ok: false, status, reason };
}

function decodeJson(part: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** An Ed25519 key of the JWKS, with its ID. Keys of other types are left out. */
function publicKey(jwk: unknown): { kid: string; key: KeyObject } | undefined {
  if (typeof jwk !== "object" || jwk === null) return undefined;
  const { kty, crv, x, kid } = jwk as Record<string, unknown>;
  if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string" || typeof kid !== "string") return undefined;
  try {
    return { kid, key: createPublicKey({ key: { kty, crv, x }, format: "jwk" }) };
  } catch {
    return undefined;
  }
}

function maxAge(cacheControl: string | null): number | undefined {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? "");
  return match ? Number(match[1]) * 1000 : undefined;
}
