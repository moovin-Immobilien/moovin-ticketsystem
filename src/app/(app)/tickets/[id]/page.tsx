import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { requireAgent, canSeeTicket } from "@/lib/auth";
import { MoovinClient } from "@/lib/moovin/client";
import type { ApplicantContext } from "@/lib/moovin/types";
import { StatusBadge, IntentBadge, ConfidenceBar, fmtLong, VerifiedBadge } from "@/components/ui";
import { DraftPanel } from "./DraftPanel";
import { takeOverAction, assignAction } from "./actions";

export default async function TicketPage(props: PageProps<"/tickets/[id]">) {
  const agent = await requireAgent();
  const { id } = await props.params;
  const ticketId = Number(id);
  if (!Number.isInteger(ticketId)) notFound();
  const [t] = await sql`select t.*, a.name as assignee_name from ticket.tickets t left join ticket.agents a on a.email = t.assignee_email where t.id = ${ticketId}`;
  if (!t || !(await canSeeTicket(agent, t as never))) notFound();

  const messages = await sql`select * from ticket.messages where ticket_id = ${ticketId} order by created_at asc`;
  const atts = await sql`select id, message_id, filename, content_type, size_bytes, forwarded_at from ticket.attachments where message_id = any(${messages.map((m) => m.id)})`;
  const [draft] = await sql`select * from ticket.drafts where ticket_id = ${ticketId} order by created_at desc limit 1`;
  const actions = draft ? await sql`select * from ticket.actions where draft_id = ${draft.id} order by id` : [];
  const agents = await sql`select email, name from ticket.agents where active order by name`;

  let ctx: ApplicantContext | null = null;
  let ctxError: string | null = null;
  try { ctx = await new MoovinClient(t.sender_email, ticketId).getApplicantContext(); } catch (e) { ctxError = (e as Error).message; }

  const analysis = (draft?.analysis ?? {}) as { summary?: string; needs_human_reason?: string; toolCalls?: string[]; aiError?: string };
  const isOpen = !["beantwortet", "geschlossen"].includes(t.status);
  const draftEditable = !!draft && draft.status === "offen" && isOpen;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/tickets" className="text-xs text-muted hover:text-navy">← Tickets</Link>
          <h1 className="text-xl font-semibold text-navy mt-1">T-{t.id} · {t.subject || "(ohne Betreff)"}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-2 text-sm">
            <StatusBadge status={t.status} />
            <IntentBadge intent={t.intent} />
            <VerifiedBadge verified={t.sender_verified} />
            {t.auto_handled && <span className="badge bg-emerald-50 text-emerald-700">automatisch beantwortet</span>}
            <span className="text-muted">Eingang {fmtLong(t.created_at)} · fällig {fmtLong(t.due_at)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted">AM:</span>
          <span className="font-medium whitespace-nowrap">{t.assignee_name ?? "Pool"}</span>
          {t.assignee_email !== agent.email && (
            <form action={takeOverAction.bind(null, ticketId)}><button className="btn-ghost">Übernehmen</button></form>
          )}
          {agent.role === "admin" && (
            <form action={async (fd: FormData) => { "use server"; await assignAction(ticketId, String(fd.get("to") ?? "")); }} className="flex gap-1">
              <select name="to" defaultValue={t.assignee_email ?? ""} className="input w-44">
                <option value="">Pool</option>
                {agents.map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
              </select>
              <button className="btn-ghost">Zuweisen</button>
            </form>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_380px] gap-5">
        <div className="space-y-5">
          {/* KI-Analyse + Entwurf */}
          <section className="card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-navy">KI-Entwurf</h2>
              <div className="flex items-center gap-3 text-xs text-muted">
                <ConfidenceBar value={t.confidence} />
                {draft && <span>{draft.model}</span>}
              </div>
            </div>
            {t.summary && <p className="text-sm text-ink bg-canvas rounded-lg px-3 py-2">{t.summary}</p>}
            {t.needs_human && isOpen && (
              <p className="text-sm rounded-lg px-3 py-2 bg-pink-50 text-pink">Mensch nötig: {t.needs_human_reason || "Bitte prüfen"}</p>
            )}
            {analysis.aiError && <p className="text-xs text-amber-700">KI-Fehler: {analysis.aiError}</p>}
            {isOpen ? (
              <DraftPanel key={draft?.id ?? 0} ticketId={ticketId} draftId={draft?.id ? Number(draft.id) : null} draftText={draft?.body_text ?? ""}
                actions={actions.map((a) => ({ id: Number(a.id), label: a.label, status: a.status, blocked_reason: a.blocked_reason, type: a.type }))}
                recipient={t.reply_to_email ?? t.sender_email} editable={draftEditable} />
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted">Ticket ist {t.status}. Neue Mails des Absenders öffnen es automatisch wieder.</p>
                {actions.length > 0 && (
                  <ul className="text-sm space-y-1">
                    {actions.map((a) => (
                      <li key={a.id} className="flex gap-2"><span className={`badge ${a.status === "ausgefuehrt" ? "bg-emerald-50 text-emerald-700" : a.status === "fehler" ? "bg-pink-50 text-pink" : "bg-slate-100 text-slate-600"}`}>{a.status}</span>{a.label}</li>
                    ))}
                  </ul>
                )}
                <DraftPanel ticketId={ticketId} draftId={null} draftText="" actions={[]} recipient="" editable={false} />
              </div>
            )}
          </section>

          {/* Verlauf */}
          <section className="space-y-3">
            <h2 className="font-semibold text-navy">Verlauf</h2>
            {messages.map((m) => (
              <article key={m.id} className={`card p-4 ${m.direction === "out" ? "ml-10 border-navy/20 bg-navy/[0.02]" : "mr-10"}`}>
                <header className="flex flex-wrap items-center gap-2 text-xs text-muted mb-2">
                  <span className="font-semibold text-ink">{m.direction === "in" ? (m.from_name || m.from_email) : "moovin"}</span>
                  <span>{m.direction === "in" ? `<${m.from_email}>` : `an ${m.to_email}`}</span>
                  <span>· {fmtLong(m.created_at)}</span>
                  {m.direction === "out" && <span className="badge bg-slate-100 text-slate-600">{m.sent_by === "ki" ? "KI automatisch" : `freigegeben von ${String(m.sent_by).replace("am:", "")}`}</span>}
                  {m.direction === "out" && m.delivery_status === "simuliert" && <span className="badge bg-amber-50 text-amber-700">Versand simuliert</span>}
                </header>
                <pre className="whitespace-pre-wrap font-[inherit] text-sm leading-relaxed">{m.body_text}</pre>
                {atts.filter((a) => a.message_id === m.id).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {atts.filter((a) => a.message_id === m.id).map((a) => (
                      <span key={a.id} className="badge bg-canvas border border-line text-muted">📎 {a.filename} · {Math.round(a.size_bytes / 1024)} KB{a.forwarded_at ? " · an moovin übergeben" : ""}</span>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </section>
        </div>

        {/* Kontext aus moovin */}
        <aside className="space-y-4">
          <section className="card p-4">
            <h2 className="font-semibold text-navy mb-3">Bewerber (live aus moovin)</h2>
            {ctxError && <p className="text-sm text-pink">moovin nicht erreichbar: {ctxError}</p>}
            {!ctx && !ctxError && (
              <p className="text-sm text-amber-700">Absender {t.sender_email} ist in moovin unbekannt. Die KI gibt keine persönlichen Daten heraus.</p>
            )}
            {ctx && (
              <div className="space-y-3 text-sm">
                <div>
                  <div className="font-medium">{ctx.applicant.salutation} {ctx.applicant.first_name} {ctx.applicant.last_name}</div>
                  <div className="text-muted">{ctx.applicant.email} · {ctx.applicant.id}</div>
                </div>
                {ctx.applications.map((a) => (
                  <div key={a.id} className="rounded-lg border border-line p-3 space-y-1.5">
                    <div className="font-medium text-ink">{a.object_title}</div>
                    <div className="text-xs text-muted">{a.id} · {a.status}</div>
                    <div>{a.status_label}</div>
                    {a.missing_documents.length > 0 && (
                      <div className="text-xs"><span className="text-pink font-medium">Fehlt:</span> {a.missing_documents.join(", ")}</div>
                    )}
                    {a.appointment && (
                      <div className="text-xs text-muted">Termin: {fmtLong(a.appointment.starts_at)} · {a.appointment.status}<br />{a.appointment.meeting_point}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="card p-4 text-xs text-muted space-y-1">
            <div className="font-semibold text-ink text-sm mb-1">Sicherheit</div>
            <div>Antworten gehen nur an die in moovin hinterlegte Adresse.</div>
            <div>Claude sieht keine Anhänge und keine Scores.</div>
            {analysis.toolCalls && analysis.toolCalls.length > 0 && <div>KI-Werkzeuge: {analysis.toolCalls.join(", ")}</div>}
            <div>Deep-Link aus moovin: <code>/tickets?email={t.sender_email}</code></div>
          </section>
        </aside>
      </div>
    </div>
  );
}
