import Link from "next/link";
import { sql } from "@/lib/db";
import { requireAgent, visibleSql, showTestTickets, testSql } from "@/lib/auth";
import { moovinEnabled } from "@/lib/settings";
import { StatusBadge, IntentBadge, ConfidenceBar, fmtDateTime, TestBadge } from "@/components/ui";

const VIEWS = [
  { key: "offen", label: "Offen" },
  { key: "meine", label: "Meine" },
  { key: "pool", label: "Allgemeiner Eingang" },
  { key: "wartet", label: "Wartet auf Bewerber" },
  { key: "ueberfaellig", label: "Überfällig" },
  { key: "erledigt", label: "Erledigt" },
] as const;

export default async function TicketsPage(props: PageProps<"/tickets">) {
  const agent = await requireAgent();
  const moovinOn = await moovinEnabled();
  const sp = await props.searchParams;
  const view = (typeof sp.view === "string" ? sp.view : "offen") as (typeof VIEWS)[number]["key"];
  const email = typeof sp.email === "string" ? sp.email.toLowerCase().trim() : "";
  const open = sql`t.status not in ('beantwortet','geschlossen','wartet') and t.merged_into is null`;

  // Sichtbarkeit: Admin alles; AM eigene + Pool + überfällige
  const visible = visibleSql(agent);
  const tests = testSql(await showTestTickets(agent));
  const filter =
    view === "meine" ? sql`t.assignee_email = ${agent.email} and ${open}` :
    view === "pool" ? sql`t.assignee_email is null and ${open}` :
    view === "ueberfaellig" ? sql`t.due_at < now() and ${open}` :
    view === "wartet" ? sql`t.status = 'wartet'` :
    view === "erledigt" ? sql`t.status in ('beantwortet','geschlossen')` : open;
  const byEmail = email ? sql`and t.sender_email = ${email}` : sql``;

  const rows = await sql`
    select t.*, a.name as assignee_name,
      (select count(*) from ticket.messages m where m.ticket_id = t.id) as msg_count,
      (select count(*) from ticket.actions x where x.ticket_id = t.id and x.status in ('vorgeschlagen','blockiert')) as open_actions
    from ticket.tickets t left join ticket.agents a on a.email = t.assignee_email
    where ${visible} and ${tests} and ${filter} ${byEmail}
    order by case when t.status in ('beantwortet','geschlossen') then 1 else 0 end, t.due_at asc nulls last, t.created_at desc
    limit 200`;

  const [counts] = await sql`
    select count(*) filter (where ${open}) as offen,
           count(*) filter (where ${open} and t.due_at < now()) as ueberfaellig,
           count(*) filter (where t.auto_handled and t.created_at > now() - interval '7 days') as auto7,
           count(*) filter (where t.first_response_at is not null and t.created_at > now() - interval '7 days') as answered7,
           percentile_cont(0.5) within group (order by extract(epoch from (t.first_response_at - t.created_at))/60) filter (where t.first_response_at is not null) as median_min
    from ticket.tickets t where ${visible} and not t.is_test`;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Offen" value={counts.offen} />
        <Kpi label="Überfällig" value={counts.ueberfaellig} warn={Number(counts.ueberfaellig) > 0} />
        <Kpi label="Auto-Antworten (7 Tage)" value={`${counts.auto7} / ${counts.answered7}`} />
        <Kpi label="Median erste Antwort" value={counts.median_min === null ? "–" : `${Math.round(Number(counts.median_min))} min`} />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {VIEWS.map((v) => (
          <Link key={v.key} href={`/tickets?view=${v.key}${email ? `&email=${encodeURIComponent(email)}` : ""}`}
            className={`px-3 py-1.5 rounded-lg text-sm border ${view === v.key ? "bg-navy text-white border-navy" : "bg-white border-line text-muted hover:text-navy"}`}>{v.label}</Link>
        ))}
        <form className="ml-auto flex gap-2" action="/tickets">
          <input type="hidden" name="view" value={view} />
          <input name="email" defaultValue={email} placeholder="Nach Mailadresse filtern" className="input w-64" />
          {email && <Link href={`/tickets?view=${view}`} className="btn-ghost">×</Link>}
        </form>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5 font-semibold">#</th>
              <th className="px-4 py-2.5 font-semibold">Absender / Betreff</th>
              <th className="px-4 py-2.5 font-semibold">Anliegen</th>
              <th className="px-4 py-2.5 font-semibold">Objekt</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5 font-semibold">KI</th>
              <th className="px-4 py-2.5 font-semibold">Fällig</th>
              <th className="px-4 py-2.5 font-semibold">AM</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-muted">Keine Tickets. Unter „Testmail“ kannst du eine Mail einspielen.</td></tr>
            )}
            {rows.map((t) => {
              const overdue = t.due_at && new Date(t.due_at) < new Date() && !["beantwortet", "geschlossen"].includes(t.status);
              return (
                <tr key={t.id} className="border-t border-line hover:bg-canvas/60">
                  <td className="px-4 py-3 text-muted tabular-nums whitespace-nowrap"><Link href={`/tickets/${t.id}`}>T-{t.id}</Link>{t.is_test && <div className="mt-1"><TestBadge isTest /></div>}</td>
                  <td className="px-4 py-3">
                    <Link href={`/tickets/${t.id}`} className="block">
                      <div className="font-medium text-ink">{t.sender_name || t.sender_email}</div>
                      <div className="text-muted truncate max-w-xs">{t.subject || "(ohne Betreff)"}</div>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <IntentBadge intent={t.intent} />
                    {t.needs_human && !["beantwortet", "geschlossen"].includes(t.status) && <div className="text-xs text-pink mt-1">Mensch nötig</div>}
                  </td>
                  <td className="px-4 py-3 text-muted max-w-[14rem] truncate">{t.object_title ?? (t.applicant_known || !moovinOn ? "–" : <span className="text-amber-700">unbekannter Absender</span>)}</td>
                  <td className="px-4 py-3"><StatusBadge status={t.status} />{t.auto_handled && <div className="text-xs text-emerald-700 mt-1">automatisch</div>}</td>
                  <td className="px-4 py-3 whitespace-nowrap"><ConfidenceBar value={t.confidence} /></td>
                  <td className={`px-4 py-3 tabular-nums whitespace-nowrap ${overdue ? "text-pink font-semibold" : "text-muted"}`}>{["beantwortet", "geschlossen", "wartet"].includes(t.status) || !t.due_at ? "–" : fmtDateTime(t.due_at)}</td>
                  <td className="px-4 py-3 text-muted whitespace-nowrap">{t.assignee_name ?? <span className="badge bg-slate-100 text-slate-600">Allg. Eingang</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Kpi({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${warn ? "text-pink" : "text-navy"}`}>{String(value)}</div>
    </div>
  );
}
