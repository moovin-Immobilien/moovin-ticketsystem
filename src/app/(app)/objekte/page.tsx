import Link from "next/link";
import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { getSetting, moovinEnabled } from "@/lib/settings";
import { zohoReady, type CrmSyncResult } from "@/lib/crm/zoho";
import { fmtLong } from "@/components/ui";
import { setMoovinModeAction, syncCrmAction, connectZohoAction, disconnectZohoAction, setupBrevoInboundAction } from "./actions";
import { mailSetupStatus, INBOUND_DOMAIN } from "@/lib/mail-setup";
import { addAgentAction } from "../team/actions";

/** Objekte & Zuordnung (Admin): moovin-Anbindung an/aus, CRM-Abgleich Objekt → AM, AMs laut CRM, Objektsuche. */
export default async function Objekte(props: PageProps<"/objekte">) {
  await requireAdmin();
  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const zohoMsg = typeof sp.zoho === "string" ? sp.zoho : "";
  const mailMsg = typeof sp.mail === "string" ? sp.mail : "";
  const mail = await mailSetupStatus();
  const zoho = await zohoReady();
  const moovinOn = await moovinEnabled();
  const sync = await getSetting<CrmSyncResult>("crm_sync");
  const [stats] = await sql`select count(*) filter (where active) as active, count(*) filter (where active and live) as live,
      count(*) filter (where active and am_email is not null) as with_am, count(*) filter (where active and match_key is not null) as with_key
    from ticket.crm_objects`;
  const ams = await sql`select o.am_name, o.am_email, count(*) filter (where o.live) as live, count(*) as total, a.active as agent_active, a.name as agent_name
    from ticket.crm_objects o left join ticket.agents a on a.email = o.am_email
    where o.active and o.am_name is not null group by o.am_name, o.am_email, a.active, a.name order by count(*) filter (where o.live) desc, o.am_name`;
  const like = `%${q}%`;
  const found = q ? await sql`select * from ticket.crm_objects where active and (object_id ilike ${like} or title ilike ${like} or am_name ilike ${like} or customer ilike ${like})
                              order by live desc, title limit 50` : [];
  const [routing] = await sql`select count(*) filter (where routing_source = 'crm_id') as crm_id, count(*) filter (where routing_source = 'crm_adresse') as crm_adresse,
      count(*) filter (where routing_source = 'moovin') as moovin, count(*) filter (where routing_source = 'manuell') as manuell,
      count(*) filter (where assignee_email is null and status not in ('beantwortet','geschlossen') and merged_into is null) as pool
    from ticket.tickets where created_at > now() - interval '30 days' and not is_test`;

  return (
    <div className="space-y-6" data-testid="objekte">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold text-navy">Objekte & Zuordnung</h1>
        <Link href="/team" className="text-sm text-muted hover:text-navy">Team →</Link>
      </div>

      <section className="card p-5 space-y-3" data-testid="moovin-mode">
        <h2 className="font-semibold text-navy">moovin-Anbindung: {moovinOn ? "an" : "aus (Livetest)"}</h2>
        <p className="text-sm text-muted max-w-3xl">
          {moovinOn
            ? "Das System fragt Bewerber, Bewerbungen und Termine bei moovin ab und führt freigegebene Aktionen dort aus."
            : "Ohne moovin-API: keine Abfragen und keine Schreibaufrufe an moovin. Der AM kommt aus dem CRM (Objekt in der Mail erkannt), die KI nennt keine persönlichen Angaben (Stand, Termin) und formuliert neutral, vorgeschlagene Aktionen werden nach der Freigabe zu Aufgaben."}
        </p>
        <form action={setMoovinModeAction.bind(null, !moovinOn)}>
          <button className={moovinOn ? "btn-ghost" : "btn-pink"}>{moovinOn ? "moovin-Anbindung ausschalten (Livetest)" : "moovin-Anbindung einschalten"}</button>
        </form>
      </section>

      <section className="card p-5 space-y-3" data-testid="mail-setup">
        <h2 className="font-semibold text-navy">Mail-Eingang (Brevo)</h2>
        <p className="text-sm text-muted max-w-3xl">mieter@moovin.de leitet an <code>mieter@{INBOUND_DOMAIN}</code> weiter; Brevo nimmt die Mails an und übergibt sie dem Ticketsystem. Antworten gehen über Brevo mit Absender mieter@moovin.de.</p>
        <ul className="text-sm space-y-1">
          <Check ok={mail.brevoKey} label="Brevo-API-Schlüssel in Vercel (BREVO_API_KEY)" />
          <Check ok={!!mail.senderDomain?.authenticated || !!mail.sender?.active} label={`Absender bei Brevo bestätigt${mail.sender ? ` (${mail.sender.email})` : ""}`}
            hint={mail.senderDomain?.authenticated ? "Domain per DNS authentifiziert" : mail.sender?.active ? "per Code bestätigt – Versand läuft; DNS-Einträge der Domain sind optional" : mail.brevoKey ? "Absender in Brevo anlegen und per Code bestätigen" : undefined} />
          <Check ok={mail.mx.ok} label={`MX-Einträge ${INBOUND_DOMAIN} → Brevo`} hint={mail.mx.hosts.length ? `aktuell: ${mail.mx.hosts.join(", ")}` : "noch keine MX-Einträge gefunden"} />
          <Check ok={!!mail.webhook?.urlOk} label="Brevo-Webhook für den Eingang eingerichtet" hint={mail.webhook && !mail.webhook.urlOk ? "zeigt auf eine andere Adresse – neu einrichten" : undefined} />
        </ul>
        {mail.error && <p className="text-sm text-pink">{mail.error}</p>}
        {mailMsg && <p className="text-sm rounded-lg bg-canvas px-3 py-2" data-testid="mail-msg">{mailMsg}</p>}
        {mail.brevoKey && (
          <form action={setupBrevoInboundAction}><button className={mail.webhook?.urlOk ? "btn-ghost" : "btn-pink"}>{mail.webhook ? "Brevo-Eingang neu einrichten" : "Brevo-Eingang einrichten"}</button></form>
        )}
      </section>

      <section className="card p-5 space-y-3" data-testid="crm-sync">
        <h2 className="font-semibold text-navy">CRM-Abgleich (Zoho, nur lesend)</h2>
        <p className="text-sm text-muted max-w-3xl">Quelle: Abschlüsse der Pipeline „Vermietung“ (offen und bis 60 Tage nach Abschluss) mit moovin-ID, Adresse und „Zuständiger Account Manager“. Täglich automatisch; ins CRM wird nichts geschrieben.</p>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
          <div><div className="text-muted text-xs">Objekte</div><div className="text-lg font-semibold tabular-nums" data-testid="crm-count">{Number(stats.active)}</div></div>
          <div><div className="text-muted text-xs">davon in Vermarktung</div><div className="text-lg font-semibold tabular-nums">{Number(stats.live)}</div></div>
          <div><div className="text-muted text-xs">mit AM-Adresse</div><div className="text-lg font-semibold tabular-nums">{Number(stats.with_am)}</div></div>
          <div><div className="text-muted text-xs">per Adresse erkennbar</div><div className="text-lg font-semibold tabular-nums">{Number(stats.with_key)}</div></div>
          <div><div className="text-muted text-xs">Letzter Abgleich</div><div className={sync && !sync.ok ? "text-pink" : ""}>{sync ? `${fmtLong(sync.at)}${sync.ok ? "" : " – Fehler"}` : "noch nie"}</div></div>
        </div>
        {sync?.error && <p className="text-sm text-pink">{sync.error}</p>}
        {sync?.unresolved?.length ? <p className="text-sm text-amber-700">AM-Namen ohne eindeutige CRM-Adresse: {sync.unresolved.join(", ")}</p> : null}
        {zohoMsg && <p className="text-sm rounded-lg bg-canvas px-3 py-2" data-testid="zoho-msg">{zohoMsg}</p>}
        {zoho.ready ? (
          <div className="flex flex-wrap items-center gap-3">
            <form action={syncCrmAction}><button className="btn-ghost">Jetzt abgleichen</button></form>
            <span className="text-xs text-muted" data-testid="zoho-status">Zoho verbunden {zoho.source === "env" ? "(Umgebungsvariablen)" : `seit ${fmtLong(zoho.connectedAt)}${zoho.connectedBy ? ` (${zoho.connectedBy.replace("am:", "")})` : ""}`}</span>
            {zoho.source === "app" && <form action={disconnectZohoAction}><button className="text-xs text-muted hover:text-pink underline">Verbindung trennen</button></form>}
          </div>
        ) : (
          <form action={connectZohoAction} className="rounded-lg border border-line p-4 space-y-3" data-testid="zoho-connect">
            <div className="font-medium text-ink text-sm">Zoho einmalig verbinden (nur lesend, ca. 3 Minuten)</div>
            <ol className="text-xs text-muted list-decimal pl-4 space-y-1 max-w-3xl">
              <li>api-console.zoho.eu öffnen (mit dem moovin-Zoho-Konto) → „Add Client“ → „Self Client“ → anlegen.</li>
              <li>Reiter „Generate Code“: Scope <code className="text-ink">ZohoCRM.coql.READ,ZohoCRM.modules.deals.READ,ZohoCRM.users.READ</code>, Dauer 10 Minuten, Beschreibung „Ticketsystem“ → „Create“ → Code kopieren.</li>
              <li>Reiter „Client Secret“: Client ID und Client Secret kopieren und mit dem Code hier eintragen. Der Code ist nur wenige Minuten gültig.</li>
            </ol>
            <div className="flex flex-wrap gap-2">
              <input name="client_id" required placeholder="Client ID" className="input w-64" autoComplete="off" />
              <input name="client_secret" required type="password" placeholder="Client Secret" className="input w-64" autoComplete="off" />
              <input name="code" required placeholder="Code (1000.…)" className="input w-72" autoComplete="off" />
              <button className="btn-pink">Verbinden & abgleichen</button>
            </div>
            <p className="text-xs text-muted">Gespeichert wird nur ein Lese-Token, serverseitig. Ins CRM wird nichts geschrieben.</p>
          </form>
        )}
        <p className="text-xs text-muted">Zuordnung der letzten 30 Tage: CRM per moovin-ID {Number(routing.crm_id)} · CRM per Adresse {Number(routing.crm_adresse)} · moovin {Number(routing.moovin)} · manuell {Number(routing.manuell)} · aktuell im Allgemeinen Eingang {Number(routing.pool)}</p>
      </section>

      <section className="card overflow-hidden" data-testid="crm-ams">
        <div className="px-5 pt-4 pb-2"><h2 className="font-semibold text-navy">AMs laut CRM</h2>
          <p className="text-xs text-muted">Tickets gehen nur an AMs, die im Ticketsystem freigeschaltet sind; die übrigen landen mit Hinweis im Allgemeinen Eingang.</p></div>
        <table className="w-full text-sm">
          <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted">
            <tr><th className="px-4 py-2">AM (CRM)</th><th className="px-4 py-2">Adresse</th><th className="px-4 py-2">in Vermarktung</th><th className="px-4 py-2">Objekte</th><th className="px-4 py-2">Ticketsystem</th></tr>
          </thead>
          <tbody>
            {ams.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-muted">Noch kein Abgleich.</td></tr>}
            {ams.map((a) => (
              <tr key={`${a.am_name}-${a.am_email}`} className="border-t border-line">
                <td className="px-4 py-2">{a.am_name}</td>
                <td className="px-4 py-2 text-muted">{a.am_email ?? <span className="text-amber-700">nicht zuordenbar</span>}</td>
                <td className="px-4 py-2 tabular-nums">{Number(a.live)}</td>
                <td className="px-4 py-2 tabular-nums">{Number(a.total)}</td>
                <td className="px-4 py-2">
                  {a.agent_active ? <span className="badge bg-emerald-50 text-emerald-700">freigeschaltet</span>
                    : a.am_email ? (
                      <form action={addAgentAction}>
                        <input type="hidden" name="email" value={a.am_email} /><input type="hidden" name="name" value={a.agent_name ?? a.am_name} />
                        <button className="btn-ghost text-xs">Freischalten</button>
                      </form>
                    ) : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold text-navy">Objekt suchen</h2>
        <form className="flex gap-2"><input name="q" defaultValue={q} placeholder="moovin-ID, Adresse, AM oder Kunde" className="input w-96" /><button className="btn-ghost">Suchen</button></form>
        {q && (
          <table className="w-full text-sm" data-testid="crm-search">
            <tbody>
              {found.length === 0 && <tr><td className="py-2 text-muted">Kein Treffer.</td></tr>}
              {found.map((o) => (
                <tr key={o.object_id} className="border-t border-line">
                  <td className="py-2 pr-3 tabular-nums">{o.object_id}</td><td className="py-2 pr-3">{o.title}</td>
                  <td className="py-2 pr-3 text-muted">{o.stage}</td><td className="py-2 pr-3">{o.am_name ?? "–"}</td><td className="py-2 text-muted">{o.customer}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Check({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <li className="flex items-baseline gap-2">
      <span className={ok ? "text-emerald-600" : "text-pink"}>{ok ? "✓" : "✗"}</span>
      <span className={ok ? "text-ink" : "text-muted"}>{label}</span>
      {hint && <span className="text-xs text-muted">· {hint}</span>}
    </li>
  );
}
