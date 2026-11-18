import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const MAX_SKEW_SECONDS = 300;

export function sha256Hex(body: string | Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Kanonischer String: timestamp \n METHOD \n path_with_query \n sha256(body) */
export function signRequest(secret: string, ts: string, method: string, pathWithQuery: string, body: string): string {
  const canonical = `${ts}\n${method.toUpperCase()}\n${pathWithQuery}\n${sha256Hex(body)}`;
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

export function verifySignature(opts: {
  keys: Record<string, string>;
  keyId: string | null;
  ts: string | null;
  signature: string | null;
  method: string;
  pathWithQuery: string;
  body: string;
  now?: number;
}): { ok: true } | { ok: false; reason: string } {
  const { keys, keyId, ts, signature } = opts;
  if (!keyId || !ts || !signature) return { ok: false, reason: "Signatur-Header fehlen" };
  const secret = keys[keyId];
  if (!secret) return { ok: false, reason: "Unbekannte Key-Id" };
  const tsNum = Number(ts);
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > MAX_SKEW_SECONDS) return { ok: false, reason: "Zeitstempel ungültig" };
  const expected = signRequest(secret, ts, opts.method, opts.pathWithQuery, opts.body);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "Signatur ungültig" };
  return { ok: true };
}

export function parseKeyList(list: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of list.split(",")) {
    const i = part.indexOf(":");
    if (i > 0) {
      const id = part.slice(0, i).trim();
      const secret = part.slice(i + 1).trim();
      if (id && secret) out[id] = secret;
    }
  }
  return out;
}
