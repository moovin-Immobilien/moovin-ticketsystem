import Link from "next/link";
import { sql } from "@/lib/db";
import { requireAgent, visibleSql, showTestTickets, testSql } from "@/lib/auth";
import { StatusBadge, IntentBadge, fmtDateTime, TestBadge } from "@/components/ui";

/** Suche über alle Tickets nach Name, Mailadresse, Objekt, Ticket-Nr. – mit denselben Sichtrechten wie die Listen. */
export default async function Suche(props: PageProps<"/suche">) {
  const agent = await requireAgent();
  const sp = await props.searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, 100);
  const idMatch = q.match(/^#?(?:t-?)?(\d{1,9})$/i);
  const tests = testSql(await showTestTickets(agent));
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = q
    ? await sql`select t.*, a.name as assignee_name from ticket.tickets t left join ticket.agents a on a.email = t.assignee_email
        where ${visibleSql(agent)} and ${tests} and (
          ${idMatch ? sql`t.id = ${Number(idMatch[1])} or` : sql``}
          t.sender_email ilike ${like} or t.sender_name ilike ${like} or t.object_title ilike ${like} or t.object_id ilike ${like} or t.subject ilike ${like})
        order by t.created_at desc limit 100`
    : [];
  return (
    <div className="space-y-5">
      <form action="/suche" className="flex gap-2">
        <input name="q" defaultValue={q} autoFocus placeholder="Name, Mailadresse, Objekt oder Ticket-Nr. (z. B. T-12)" className="input h-11 flex-1" />
        <button className="btn-pink h-11">Suchen</button>
      </form>
      {q && (
        <div className="card overflow-hidden" data-testid="search-results">
          <div className="px-4 py-2 text-xs text-muted bg-canvas">{rows.length} Treffer{agent.role !== "admin" ? " (eigene, Allgemeiner Eingang und überfällige Tickets)" : ""}</div>
          <table className="w-full text-sm">
            <tbody>
              {rows.length === 0 && <tr><td className="px-4 py-8 text-center text-muted">Keine Treffer.</td></tr>}
              {rows.map((t) => (
                <tr key={t.id} className="border-t border-line hover:bg-canvas/60">
                  <td className="px-4 py-3 text-muted tabular-nums"><Link href={`/tickets/${t.id}`}>T-{t.id}</Link>{t.is_test && <div className="mt-1"><TestBadge isTest /></div>}</td>
                  <td className="px-4 py-3"><Link href={`/tickets/${t.id}`}><div className="font-medium">{t.sender_name || t.sender_email}</div><div className="text-muted">{t.sender_email}</div></Link></td>
                  <td className="px-4 py-3 text-muted">{t.object_title ?? "–"}</td>
                  <td className="px-4 py-3"><IntentBadge intent={t.intent} /></td>
                  <td className="px-4 py-3"><StatusBadge status={t.status} />{t.merged_into && <div className="text-xs text-muted">→ T-{t.merged_into}</div>}</td>
                  <td className="px-4 py-3 text-muted whitespace-nowrap">{fmtDateTime(t.created_at)}</td>
                  <td className="px-4 py-3 text-muted whitespace-nowrap">{t.assignee_name ?? "Allgemeiner Eingang"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
