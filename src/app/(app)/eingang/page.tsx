import Link from "next/link";
import { sql } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { knownObjects } from "@/lib/objects";
import { StatusBadge, IntentBadge, fmtDateTime } from "@/components/ui";
import { assignAction, taskDoneAction } from "../tickets/[id]/actions";

/** Allgemeiner Eingang: alles ohne zuständigen AM. Zuordnung per Klick zu Objekt und/oder AM (Audit-Log). */
export default async function Eingang() {
  await requireAgent();
  const rows = await sql`select t.*, d.name as deputy_for_name from ticket.tickets t left join ticket.agents d on d.email = t.deputy_for
    where t.assignee_email is null and t.status not in ('beantwortet','geschlossen') and t.merged_into is null
    order by case when t.due_at < now() then 0 else 1 end, t.due_at nulls last, t.created_at`;
  const tasks = await sql`select k.*, t.sender_name, t.sender_email from ticket.tasks k join ticket.tickets t on t.id = k.ticket_id
    where k.assignee_email is null and k.status = 'offen' order by k.created_at`;
  const agents = await sql`select email, name from ticket.agents where active order by name`;
  const objects = await knownObjects();

  const reason = (t: Record<string, unknown>) =>
    t.deputy_for ? `AM ${t.deputy_for_name ?? t.deputy_for} abwesend, keine Vertretung`
    : t.intent === "nicht_zustaendig" ? "Nicht zuständig"
    : t.intent === "intern_system" ? "System-/interne Mail"
    : !t.applicant_known ? "Kein Bewerber in moovin"
    : !t.object_id ? "Keine Zuordnung zu einer Wohnung"
    : "Kein AM hinterlegt";

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-navy">Allgemeiner Eingang</h1>
        <p className="text-sm text-muted">Tickets ohne zuständigen AM. Objekt und/oder AM zuordnen – ohne AM-Auswahl übernimmt der AM, der das Objekt zuletzt betreut hat.</p>
      </div>
      <datalist id="objects">{objects.map((o) => <option key={o.object_id} value={`${o.object_id} · ${o.object_title ?? ""}`} />)}</datalist>

      <div className="card overflow-hidden" data-testid="eingang">
        <table className="w-full text-sm">
          <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted">
            <tr><th className="px-4 py-2.5">#</th><th className="px-4 py-2.5">Absender / Grund</th><th className="px-4 py-2.5">Anliegen</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5">Fällig</th><th className="px-4 py-2.5">Zuordnen</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-muted">Der Allgemeine Eingang ist leer.</td></tr>}
            {rows.map((t) => {
              const overdue = t.due_at && new Date(t.due_at) < new Date() && t.status !== "wartet";
              return (
                <tr key={t.id} className="border-t border-line align-top" data-testid={`eingang-${t.id}`}>
                  <td className="px-4 py-3 text-muted tabular-nums"><Link href={`/tickets/${t.id}`}>T-{t.id}</Link></td>
                  <td className="px-4 py-3">
                    <Link href={`/tickets/${t.id}`} className="font-medium text-ink">{t.sender_name || t.sender_email}</Link>
                    <div className="text-muted truncate max-w-xs">{t.subject || "(ohne Betreff)"}</div>
                    <div className="text-xs text-amber-700 mt-1">{reason(t)}</div>
                  </td>
                  <td className="px-4 py-3"><IntentBadge intent={t.intent} /></td>
                  <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                  <td className={`px-4 py-3 tabular-nums whitespace-nowrap ${overdue ? "text-pink font-semibold" : "text-muted"}`}>{t.due_at ? fmtDateTime(t.due_at) : "–"}</td>
                  <td className="px-4 py-3">
                    <form action={assignAction.bind(null, Number(t.id))} className="flex flex-col gap-1 w-64">
                      <input name="object" list="objects" placeholder={t.object_id ? `${t.object_id} · ${t.object_title ?? ""}` : "Objekt"} className="input" />
                      <div className="flex gap-1">
                        <select name="to" defaultValue="" className="input">
                          <option value="">AM aus Objekt</option>
                          {agents.map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
                        </select>
                        <button className="btn-ghost">Zuordnen</button>
                      </div>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {tasks.length > 0 && (
        <section className="card p-4 space-y-2">
          <h2 className="font-semibold text-navy">Aufgaben ohne AM</h2>
          {tasks.map((k) => (
            <div key={k.id} className="flex items-start gap-3 text-sm">
              <form action={taskDoneAction.bind(null, Number(k.id), true)}><button className="mt-0.5 h-5 w-5 rounded border border-line bg-white" aria-label="Abhaken" /></form>
              <div>{k.text}<div className="text-xs text-muted"><Link className="underline" href={`/tickets/${k.ticket_id}`}>T-{k.ticket_id}</Link> · {k.sender_name || k.sender_email}</div></div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
