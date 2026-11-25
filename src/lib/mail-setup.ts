import "server-only";
import { promises as dns } from "node:dns";
import { env } from "./env";
import { audit } from "./audit";

/**
 * Einrichtung des Mail-Eingangs über Brevo, ohne dass Schlüssel oder Token den Server verlassen:
 * Status (API-Schlüssel, MX der Empfangs-Subdomain, Absenderdomain bestätigt, Inbound-Webhook) und
 * Anlegen/Aktualisieren des Inbound-Webhooks (Brevo bietet das nur per API an).
 */
export const INBOUND_DOMAIN = process.env.INBOUND_DOMAIN || "reply.moovin.de";
const BREVO_MX = ["inbound1.sendinblue.com", "inbound2.sendinblue.com", "inbound1.brevo.com", "inbound2.brevo.com"];

type Hook = { id: number; url: string; domain?: string; type?: string; description?: string };
export type MailSetupStatus = {
  brevoKey: boolean;
  mx: { ok: boolean; hosts: string[] };
  senderDomain: { name: string; authenticated: boolean; verified: boolean } | null;
  webhook: { id: number; domain: string; urlOk: boolean } | null;
  error?: string;
};

function webhookUrl() {
  return `${env.appUrl()}/api/inbound/email?token=${encodeURIComponent(env.inboundToken())}`;
}

async function brevo<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${env.brevoApiBase()}/v3${path}`, {
    ...init,
    headers: { "api-key": env.brevoApiKey(), Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${j.message ?? j.code ?? ""}`.trim());
  return j as T;
}

async function mxHosts(domain: string): Promise<string[]> {
  if (process.env.NODE_ENV !== "production" && process.env.MX_TEST_HOSTS !== undefined) return process.env.MX_TEST_HOSTS.split(",").filter(Boolean);
  try { return (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange.toLowerCase().replace(/\.$/, "")); } catch { return []; }
}

export async function mailSetupStatus(): Promise<MailSetupStatus> {
  const hosts = await mxHosts(INBOUND_DOMAIN);
  const status: MailSetupStatus = { brevoKey: !!env.brevoApiKey(), mx: { ok: hosts.some((h) => BREVO_MX.includes(h)), hosts }, senderDomain: null, webhook: null };
  if (!status.brevoKey) return status;
  try {
    const sender = env.fromAddress().match(/@([^>\s]+)/)?.[1]?.toLowerCase() ?? "moovin.de";
    const d = await brevo<{ domains?: { domain_name: string; authenticated?: boolean; verified?: boolean }[] }>("/senders/domains").catch(() => ({ domains: [] }));
    const dom = (d.domains ?? []).find((x) => x.domain_name?.toLowerCase() === sender);
    status.senderDomain = dom ? { name: dom.domain_name, authenticated: !!dom.authenticated, verified: !!dom.verified } : null;
    const hooks = await brevo<{ webhooks?: Hook[] }>("/webhooks?type=inbound");
    const h = (hooks.webhooks ?? []).find((x) => (x.domain ?? "").toLowerCase() === INBOUND_DOMAIN);
    status.webhook = h ? { id: h.id, domain: h.domain ?? "", urlOk: h.url === webhookUrl() } : null;
  } catch (e) {
    status.error = (e as Error).message.slice(0, 200);
  }
  return status;
}

/** Inbound-Webhook für die Empfangs-Subdomain anlegen bzw. auf die aktuelle URL setzen. Token erscheint nie im Browser oder Audit-Log. */
export async function setupBrevoInbound(actor: string): Promise<string> {
  if (!env.brevoApiKey()) throw new Error("BREVO_API_KEY fehlt in Vercel – erst eintragen und neu deployen.");
  const hooks = await brevo<{ webhooks?: Hook[] }>("/webhooks?type=inbound");
  const existing = (hooks.webhooks ?? []).find((x) => (x.domain ?? "").toLowerCase() === INBOUND_DOMAIN);
  const body = { url: webhookUrl(), description: "moovin Ticketsystem – Eingang mieter@", events: ["inboundEmailProcessed"] };
  if (existing) {
    await brevo(`/webhooks/${existing.id}`, { method: "PUT", body: JSON.stringify(body) });
    await audit(actor, "settings", { event: "brevo_eingang_aktualisiert", domain: INBOUND_DOMAIN, webhook: existing.id });
    return `Brevo-Eingang für ${INBOUND_DOMAIN} aktualisiert.`;
  }
  const r = await brevo<{ id?: number }>("/webhooks", { method: "POST", body: JSON.stringify({ ...body, type: "inbound", domain: INBOUND_DOMAIN }) });
  await audit(actor, "settings", { event: "brevo_eingang_eingerichtet", domain: INBOUND_DOMAIN, webhook: r.id ?? null });
  return `Brevo-Eingang für ${INBOUND_DOMAIN} eingerichtet.`;
}
