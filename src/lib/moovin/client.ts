import "server-only";
import { randomUUID } from "node:crypto";
import { env } from "../env";
import { signRequest } from "../hmac";
import { audit } from "../audit";
import type { ApplicantContext, ObjectInfo } from "./types";

/**
 * Einziger Weg des Ticketsystems zu moovin. Jeder Aufruf ist
 *  - HMAC-signiert,
 *  - an EINE Absender-Mailadresse gebunden (X-Subject-Email) – moovin prüft die Zugehörigkeit,
 *  - im Audit-Log protokolliert.
 * Claude ruft diesen Client nie direkt auf.
 */
export class MoovinClient {
  constructor(private subjectEmail: string, private ticketId: number | null = null) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<{ status: number; data: T | null }> {
    const base = new URL(env.moovinApiUrl());
    const url = new URL(base.pathname.replace(/\/$/, "") + path, base);
    const bodyStr = body === undefined ? "" : JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = signRequest(env.moovinSecret(), ts, method, url.pathname + url.search, bodyStr);
    const headers: Record<string, string> = {
      "X-Moovin-Key-Id": env.moovinKeyId(),
      "X-Moovin-Timestamp": ts,
      "X-Moovin-Signature": sig,
      "X-Subject-Email": this.subjectEmail,
      "X-Request-Id": randomUUID(),
    };
    if (bodyStr) headers["Content-Type"] = "application/json";
    // Prototyp: Attrappe läuft in derselben, per Vercel-Auth geschützten App → Bypass-Header nur für eigene Domain
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass && url.host === new URL(env.appUrl()).host) headers["x-vercel-protection-bypass"] = bypass;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    const started = Date.now();
    let status = 0;
    try {
      const res = await fetch(url, { method, headers, body: bodyStr || undefined, cache: "no-store", signal: AbortSignal.timeout(10_000) });
      status = res.status;
      const data = res.status === 204 ? null : ((await res.json().catch(() => null)) as T | null);
      return { status, data };
    } finally {
      await audit("system", "moovin_api", { method, path: url.pathname, status, ms: Date.now() - started, subject: this.subjectEmail }, this.ticketId);
    }
  }

  async getApplicantContext(): Promise<ApplicantContext | null> {
    const r = await this.call<ApplicantContext>("GET", `/applicants?email=${encodeURIComponent(this.subjectEmail)}`);
    if (r.status === 404) return null;
    if (r.status !== 200 || !r.data) throw new Error(`moovin /applicants: HTTP ${r.status}`);
    return r.data;
  }

  async getObject(objectId: string): Promise<ObjectInfo | null> {
    const r = await this.call<ObjectInfo>("GET", `/objects/${encodeURIComponent(objectId)}`);
    if (r.status === 404) return null;
    if (r.status !== 200 || !r.data) throw new Error(`moovin /objects: HTTP ${r.status}`);
    return r.data;
  }

  async post(path: string, body: unknown, idempotencyKey: string) {
    const r = await this.call<Record<string, unknown>>("POST", path, body, idempotencyKey);
    if (r.status >= 300) throw new Error(`moovin ${path}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
}
