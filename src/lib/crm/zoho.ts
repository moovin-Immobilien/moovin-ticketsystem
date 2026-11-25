import "server-only";
import { sql } from "../db";
import { env, zohoConfigured } from "../env";
import { audit } from "../audit";
import { setSetting } from "../settings";
import { addressKey, resolveAmEmail } from "./match";
import { invalidateObjectCache } from "./objects";

/**
 * Täglicher, rein lesender Abgleich Objekt → AM aus Zoho CRM.
 * Quelle: Modul „Abschlüsse“ (Deals), Pipeline „Vermietung“; Felder moovin_ID, Straße/PLZ/Ort, „Zuständiger Account Manager“.
 * Ins CRM wird nie geschrieben (Scopes nur *.READ). AM-Name → Mailadresse über die CRM-Benutzer.
 */

export const LIVE_STAGES = ["Online / Besichtigungen", "Quervermarktung", "Mieter vorschlagen", "Mietvertrag", "Exposé-Erstellung"];
const CLOSED_STAGES = ["abgeschlossen (gewonnen)", "abgeschlossen (verloren)", "Rechnungserstellung"];
const RECENT_CLOSED_DAYS = 60; // Bewerber schreiben auch kurz nach Abschluss noch
const FIELDS = "Deal_Name, Stage, Neu_Zust_ndiger_Account_Manager, Stra_e, PLZ, Ort, moovin_ID, Kunden_Objekt_ID, Account_Name.Account_Name, Modified_Time";

type Deal = Record<string, string | null> & { id: string };
export type CrmSyncResult = { ok: boolean; at: string; rows: number; live: number; withAm: number; deactivated: number; unresolved: string[]; error?: string };

async function accessToken(): Promise<string> {
  const p = new URLSearchParams({ refresh_token: env.zohoRefreshToken(), client_id: env.zohoClientId(), client_secret: env.zohoClientSecret(), grant_type: "refresh_token" });
  const r = await fetch(`${env.zohoAccountsUrl()}/oauth/v2/token`, { method: "POST", body: p, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!r.ok || !j.access_token) throw new Error(`Zoho-Anmeldung fehlgeschlagen (${r.status} ${j.error ?? ""})`.trim());
  return j.access_token;
}

async function coql(token: string, query: string): Promise<Deal[]> {
  const r = await fetch(`${env.zohoApiBase()}/crm/v8/coql`, {
    method: "POST", headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ select_query: query }),
  });
  if (r.status === 204) return [];
  const j = (await r.json().catch(() => ({}))) as { data?: Deal[]; code?: string; message?: string };
  if (!r.ok) throw new Error(`Zoho COQL ${r.status}: ${j.code ?? ""} ${j.message ?? ""}`.trim());
  return j.data ?? [];
}

async function coqlAll(token: string, where: string): Promise<Deal[]> {
  const out: Deal[] = [];
  for (let offset = 0; offset < 50_000; offset += 2000) {
    const page = await coql(token, `select ${FIELDS} from Deals where ${where} order by id asc limit ${offset}, 2000`);
    out.push(...page);
    if (page.length < 2000) break;
  }
  return out;
}

async function crmUsers(token: string): Promise<{ full_name: string; email: string; active: boolean }[]> {
  const out: { full_name: string; email: string; active: boolean }[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`${env.zohoApiBase()}/crm/v8/users?type=AllUsers&per_page=200&page=${page}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    if (r.status === 204) break;
    const j = (await r.json().catch(() => ({}))) as { users?: { full_name: string; email: string; status: string }[]; info?: { more_records?: boolean } };
    if (!r.ok) throw new Error(`Zoho Benutzer ${r.status}`);
    for (const u of j.users ?? []) if (u.email) out.push({ full_name: u.full_name ?? "", email: u.email.toLowerCase(), active: u.status === "active" });
    if (!j.info?.more_records) break;
  }
  return out;
}

const q = (s: string) => `'${s.replace(/'/g, "\\'")}'`;

export async function syncCrmObjects(actor = "system"): Promise<CrmSyncResult> {
  const at = new Date().toISOString();
  if (!zohoConfigured()) {
    const res: CrmSyncResult = { ok: false, at, rows: 0, live: 0, withAm: 0, deactivated: 0, unresolved: [], error: "Zoho-Zugang nicht hinterlegt (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN)" };
    await setSetting("crm_sync", res, actor);
    return res;
  }
  try {
    const token = await accessToken();
    const since = new Date(Date.now() - RECENT_CLOSED_DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
    const open = await coqlAll(token, `Pipeline = 'Vermietung' and Stage not in (${CLOSED_STAGES.map(q).join(", ")})`);
    const recent = await coqlAll(token, `Pipeline = 'Vermietung' and Stage in (${q("abgeschlossen (gewonnen)")}, ${q("Rechnungserstellung")}) and Modified_Time >= '${since}'`);
    const users = await crmUsers(token);

    // Eine Zeile je Objekt; bei doppelter moovin-ID gewinnt das Objekt in Vermarktung bzw. das zuletzt geänderte
    const byId = new Map<string, Deal>();
    const rank = (d: Deal) => `${LIVE_STAGES.includes(d.Stage ?? "") ? 2 : CLOSED_STAGES.includes(d.Stage ?? "") ? 0 : 1}${d.Modified_Time ?? ""}`;
    for (const d of [...open, ...recent]) {
      const id = (d.moovin_ID ?? "").trim().toUpperCase() || `CRM-${d.id}`;
      const prev = byId.get(id);
      if (!prev || rank(d) > rank(prev)) byId.set(id, d);
    }
    const nameCache = new Map<string, string | null>();
    const unresolved = new Set<string>();
    const rows = [...byId].map(([objectId, d]) => {
      const amName = d.Neu_Zust_ndiger_Account_Manager?.trim() || null;
      let amEmail: string | null = null;
      if (amName) {
        if (!nameCache.has(amName)) nameCache.set(amName, resolveAmEmail(amName, users));
        amEmail = nameCache.get(amName) ?? null;
        if (!amEmail) unresolved.add(amName);
      }
      const title = [d.Stra_e?.trim(), [d.PLZ, d.Ort].filter(Boolean).join(" ")].filter(Boolean).join(", ") || d.Deal_Name || objectId;
      return {
        object_id: objectId, crm_id: String(d.id), title, street: d.Stra_e ?? null, zip: d.PLZ ?? null, city: d.Ort ?? null,
        match_key: addressKey(d.Stra_e), customer: d["Account_Name.Account_Name"] ?? null, customer_object_id: d.Kunden_Objekt_ID ?? null,
        stage: d.Stage ?? null, live: LIVE_STAGES.includes(d.Stage ?? ""), am_name: amName, am_email: amEmail,
      };
    });

    let deactivated = 0;
    await sql.begin(async (tx) => {
      // crm_id kann zu einer anderen Objekt-ID wandern (moovin-ID nachgetragen) → vor dem Abgleich freigeben
      await tx`update ticket.crm_objects set crm_id = null where source = 'zoho'`;
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, active: true, source: "zoho", synced_at: at }));
        await tx`insert into ticket.crm_objects ${tx(chunk)}
          on conflict (object_id) do update set crm_id = excluded.crm_id, title = excluded.title, street = excluded.street, zip = excluded.zip,
            city = excluded.city, match_key = excluded.match_key, customer = excluded.customer, customer_object_id = excluded.customer_object_id,
            stage = excluded.stage, live = excluded.live, am_name = excluded.am_name, am_email = excluded.am_email, active = true,
            source = 'zoho', synced_at = excluded.synced_at`;
      }
      const d = await tx`update ticket.crm_objects set active = false where source = 'zoho' and active and synced_at < ${at} returning object_id`;
      deactivated = d.length;
    });
    invalidateObjectCache();

    const res: CrmSyncResult = { ok: true, at, rows: rows.length, live: rows.filter((r) => r.live).length, withAm: rows.filter((r) => r.am_email).length, deactivated, unresolved: [...unresolved].sort() };
    await setSetting("crm_sync", res, actor);
    await audit(actor, "settings", { event: "crm_abgleich", ...res });
    return res;
  } catch (e) {
    const res: CrmSyncResult = { ok: false, at, rows: 0, live: 0, withAm: 0, deactivated: 0, unresolved: [], error: (e as Error).message.slice(0, 300) };
    await setSetting("crm_sync", res, actor);
    await audit(actor, "settings", { event: "crm_abgleich_fehler", error: res.error });
    return res;
  }
}
