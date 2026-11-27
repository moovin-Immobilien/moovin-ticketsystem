import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { requireAgent, canSeeTicket } from "@/lib/auth";
import { MoovinClient } from "@/lib/moovin/client";
import type { ApplicantContext } from "@/lib/moovin/types";
import { StatusBadge, IntentBadge, ConfidenceBar, fmtLong, VerifiedBadge, TestBadge, TaskText } from "@/components/ui";
import { DraftPanel } from "./DraftPanel";
import { Presence } from "./Presence";
import { takeOverAction, assignAction, addNoteAction, handoverAction, mergeAction, reviewedAction, taskDoneAction, signalFeedbackAction, reopenAction } from "./actions";
import { SIGNAL_INFO, type Signal } from "@/lib/signals";
import { STAGE_LABEL, markClass } from "@/components/signals";
import { knownObjects } from "@/lib/objects";
import { moovinEnabled } from "@/lib/settings";
import { crmObject } from "@/lib/crm/objects";
import { classifyAttachment } from "@/lib/attachments";

export default async function TicketPage(props: PageProps<"/tickets/[id]">) {
  const agent = await requireAgent();
  const { id } = await props.params;
  const ticketId = Number(id);
  if (!Number.isInteger(ticketId)) notFound();
  const [t] = await sql`select t.*, a.name as assignee_name from ticket.tickets t left join ticket.agents a on a.email = t.assignee_email where t.id = ${ticketId}`;
  if (!t || !(await canSeeTicket(agent, t as never))) notFound();

  const messages = await sql`select * from ticket.messages where ticket_id = ${ticketId} order by created_at asc`;
  const atts = (await sql<{ id: string; message_id: string; filename: string; content_type: string; size_bytes: number; forwarded_at: Date | null; head: Buffer | null }[]>`select id, message_id, filename, content_type, size_bytes, forwarded_at, substring(content from 1 for 16) as head
    from ticket.attachments where message_id = any(${messages.map((m) => m.id)})`).map((a) => ({ ...a, cls: classifyAttachment(a.filename, new Uint8Array(a.head ?? [])) }));
  const [draft] = await sql`select * from ticket.drafts where ticket_id = ${ticketId} order by created_at desc limit 1`;
  const actions = draft ? await sql`select * from ticket.actions where draft_id = ${draft.id} order by id` : [];
  const agents = await sql`select email, name from ticket.agents where active order by name`;
  const notes = await sql`select n.*, a.name as author_name, g.name as target_name from ticket.notes n left join ticket.agents a on a.email = n.author_email
                          left join ticket.agents g on g.email = n.target_email where n.ticket_id = ${ticketId} order by n.created_at`;
  const tasks = await sql`select k.*, a.name as assignee_name from ticket.tasks k left join ticket.agents a on a.email = k.assignee_email where k.ticket_id = ${ticketId} order by k.status, k.created_at`;
  const siblings = await sql`select id, subject, status, created_at from ticket.tickets where sender_email = ${t.sender_email} and id <> ${ticketId} and merged_into is null order by created_at desc limit 10`;
  const objects = await knownObjects();
  const lastOutId = messages.filter((m) => m.direction === "out").reduce((mx, m) => Math.max(mx, Number(m.id)), 0) || null;
  const deputyForName = t.deputy_for ? (agents.find((a) => a.email === t.deputy_for)?.name ?? t.deputy_for) : null;

  const moovinOn = await moovinEnabled();
  let ctx: ApplicantContext | null = null;
  let ctxError: string | null = null;
  if (moovinOn) {
    try { ctx = await new MoovinClient(t.sender_email, ticketId).getApplicantContext(); } catch (e) { ctxError = (e as Error).message; }
  }
  const obj = t.object_id ? await crmObject(t.object_id) : null;
  const ROUTING: Record<string, string> = { moovin: "aus moovin", crm_id: "CRM (moovin-ID in der Mail)", crm_adresse: "CRM (Adresse in der Mail)", manuell: "manuell zugeordnet" };

  const signals = (t.signals ?? []) as Signal[];
  const analysis = (draft?.analysis ?? {}) as { summary?: string; needs_human_reason?: string; toolCalls?: string[]; aiError?: string; awaits_reply?: boolean };
  const isOpen = !["beantwortet", "geschlossen", "wartet"].includes(t.status);
  const draftEditable = !!draft && draft.status === "offen" && isOpen;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/tickets" className="text-xs text-muted hover:text-navy">← Tickets</Link>
          <h1 className="text-xl font-semibold text-navy mt-1">T-{t.id} · {t.subject || "(ohne Betreff)"}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-2 text-sm">
            <TestBadge isTest={t.is_test} />
            {t.is_test && t.test_run && agent.role === "admin" && <Link href={`/simulieren/bericht?run=${t.test_run}`} className="text-xs underline text-violet-800">Lauf {t.test_run}</Link>}
            <StatusBadge status={t.status} />
            <IntentBadge intent={t.intent} />
            <VerifiedBadge verified={t.sender_verified} />
            {t.auto_handled && <span className="badge bg-emerald-50 text-emerald-700">automatisch beantwortet</span>}
            {t.auto_handled && (t.reviewed_at
              ? <span className="badge bg-emerald-50 text-emerald-700">gegengelesen</span>
              : <form action={reviewedAction.bind(null, ticketId)}><button className="badge bg-white border border-line text-navy hover:bg-canvas">Als gegengelesen markieren</button></form>)}
            {t.status === "wartet" && <span className="badge bg-slate-100 text-slate-600">wartet seit {fmtLong(t.waiting_since)}</span>}
            {t.reopened_at && <span className="badge bg-amber-50 text-amber-700">wiedereröffnet {fmtLong(t.reopened_at)}</span>}
            <span className="text-muted">Eingang {fmtLong(t.created_at)}{t.due_at ? ` · fällig ${fmtLong(t.due_at)}` : ""}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted">AM:</span>
            <span className="font-medium whitespace-nowrap" data-testid="assignee">{t.assignee_name ?? "Allgemeiner Eingang"}</span>
            {deputyForName && <span className="badge bg-slate-100 text-slate-600">Vertretung für {deputyForName}</span>}
            {t.assignee_email !== agent.email && (
              <form action={takeOverAction.bind(null, ticketId)}><button className="btn-ghost">Übernehmen</button></form>
            )}
          </div>
          <form action={assignAction.bind(null, ticketId)} className="flex gap-1" data-testid="assign-form">
            <input name="object" list="objects" placeholder={t.object_id ? `${t.object_id} · ${t.object_title ?? ""}` : "Objekt zuordnen"} className="input w-56" />
            <datalist id="objects">{objects.map((o) => <option key={o.object_id} value={`${o.object_id} · ${o.object_title ?? ""}`} />)}</datalist>
            <select name="to" defaultValue="" className="input w-44">
              <option value="">{t.assignee_email ? "AM unverändert" : "AM (aus Objekt)"}</option>
              {agents.map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
            </select>
            <button className="btn-ghost">Zuordnen</button>
          </form>
        </div>
      </div>

      <Presence ticketId={ticketId} lastOutId={lastOutId} />
      {t.merged_into && (
        <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">Zusammengeführt in <Link className="underline" href={`/tickets/${t.merged_into}`}>T-{t.merged_into}</Link>.</p>
      )}

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
                recipient={t.reply_to_email ?? t.sender_email} editable={draftEditable && !t.merged_into} awaitsReply={!!analysis.awaits_reply} lastOutId={lastOutId} />
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted flex items-center gap-3">
                  <span>{t.status === "wartet" ? "Ticket wartet auf die Antwort des Bewerbers. Seine Antwort holt es automatisch zurück." : `Ticket ist ${t.status}. Neue Mails des Absenders öffnen es automatisch wieder.`}</span>
                  {!t.merged_into && <form action={reopenAction.bind(null, ticketId)}><button className="badge bg-white border border-line text-navy hover:bg-canvas" data-testid="reopen">Wiedereröffnen</button></form>}
                </p>
                {actions.length > 0 && (
                  <ul className="text-sm space-y-1">
                    {actions.map((a) => (
                      <li key={a.id} className="flex gap-2"><span className={`badge ${a.status === "ausgefuehrt" ? "bg-emerald-50 text-emerald-700" : a.status === "fehler" ? "bg-pink-50 text-pink" : "bg-slate-100 text-slate-600"}`}>{a.status}</span>{a.label}</li>
                    ))}
                  </ul>
                )}
                {!t.merged_into && <DraftPanel ticketId={ticketId} draftId={null} draftText="" actions={[]} recipient="" editable={false} />}
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
                      <span key={a.id} data-testid="attachment" className="badge bg-canvas border border-line text-muted gap-2">
                        📎 {a.filename} · {Math.round(a.size_bytes / 1024)} KB{a.forwarded_at ? " · an moovin übergeben" : ""}
                        {a.cls.kind === "blocked" ? (
                          <span className="text-pink" title="Aus Sicherheitsgründen gesperrt – beim Bewerber als PDF anfordern">gesperrt: {a.cls.reason}</span>
                        ) : (
                          <>
                            {a.cls.preview && <a className="text-navy underline" href={`/api/attachments/${a.id}`} target="_blank" rel="noopener noreferrer">Ansehen</a>}
                            <a className="text-navy underline" href={`/api/attachments/${a.id}?download=1`}>Herunterladen</a>
                          </>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </section>
        </div>

        {/* Kontext aus moovin */}
        <aside className="space-y-4">
          {(signals.length > 0 || Number(t.priority) !== 3) && (
            <section className={`card p-4 space-y-2 ${markClass(t.priority, signals)}`} data-testid="signals-card">
              <h2 className="font-semibold text-navy">Ticket-Intelligenz <span className="text-xs font-normal text-muted">– Stufe {String(t.priority)}: {STAGE_LABEL[Number(t.priority)]}</span></h2>
              <ul className="space-y-2 text-sm">
                {signals.map((s) => (
                  <li key={s.type}>
                    <div className="font-medium text-ink">{SIGNAL_INFO[s.type]?.label ?? s.type}
                      <span className="ml-2 text-xs font-normal text-muted">{s.confirmed && s.basis === "daten" ? "bestätigt durch Daten" : s.basis === "mail" && !s.confirmed ? "laut Mail" : "aus der Mail"}{s.stage === 3 ? " · nur Hinweis" : ""}</span>
                    </div>
                    <div className="text-xs text-muted">{s.why}{s.evidence ? <> · „{s.evidence}“</> : null}</div>
                  </li>
                ))}
              </ul>
              {signals.length > 0 && (
                <form action={signalFeedbackAction.bind(null, ticketId)} className="flex gap-2 pt-1" data-testid="signal-feedback">
                  <select name="signal" className="input text-xs" defaultValue={signals[0].type}>
                    {signals.map((s) => <option key={s.type} value={s.type}>{SIGNAL_INFO[s.type]?.label ?? s.type}</option>)}
                  </select>
                  <button className="btn-ghost whitespace-nowrap text-xs">Markierung passt nicht</button>
                </form>
              )}
            </section>
          )}
          <section className="card p-4 space-y-3" data-testid="notes">
            <h2 className="font-semibold text-navy">Intern <span className="text-xs font-normal text-muted">– nie an Bewerber, moovin oder KI</span></h2>
            {notes.length === 0 && <p className="text-xs text-muted">Noch keine internen Notizen.</p>}
            <ul className="space-y-2">
              {notes.map((n) => (
                <li key={n.id} className={`rounded-lg px-3 py-2 text-sm ${n.kind === "system" ? "bg-canvas text-muted" : n.kind === "weitergabe" ? "bg-blue-50 text-blue-900" : "bg-amber-50 text-amber-900"}`}>
                  <div className="text-xs opacity-70 mb-0.5">
                    {n.kind === "system" ? "System" : n.author_name ?? n.author_email}{n.kind === "weitergabe" ? ` → ${n.target_name ?? n.target_email}` : ""} · {fmtLong(n.created_at)}
                  </div>
                  <div className="whitespace-pre-wrap">{n.text}</div>
                </li>
              ))}
            </ul>
            <form action={addNoteAction.bind(null, ticketId)} className="space-y-2">
              <textarea name="text" required placeholder="Interne Notiz …" className="input min-h-16 text-sm" />
              <button className="btn-ghost">Notiz speichern</button>
            </form>
            <form action={handoverAction.bind(null, ticketId)} className="space-y-2 border-t border-line pt-3" data-testid="handover-form">
              <div className="label">Weitergeben an</div>
              <select name="to" required defaultValue="" className="input">
                <option value="" disabled>Kollegin/Kollege wählen</option>
                {agents.filter((a) => a.email !== agent.email).map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
              </select>
              <textarea name="text" placeholder="Kommentar für die Kollegin/den Kollegen" className="input min-h-14 text-sm" />
              <button className="btn-ghost">Weitergeben</button>
            </form>
          </section>

          {tasks.length > 0 && (
            <section className="card p-4 space-y-2" data-testid="ticket-tasks">
              <h2 className="font-semibold text-navy">Aufgaben</h2>
              {tasks.map((k) => (
                <div key={k.id} className="flex items-start gap-2 text-sm">
                  <form action={taskDoneAction.bind(null, Number(k.id), k.status !== "erledigt")}>
                    <button title={k.status === "erledigt" ? "Wieder öffnen" : "Abhaken"} className={`mt-0.5 h-4 w-4 rounded border ${k.status === "erledigt" ? "bg-emerald-500 border-emerald-500" : "border-line bg-white"}`} />
                  </form>
                  <div className={k.status === "erledigt" ? "line-through text-muted" : ""}><TaskText text={k.text} /><div className="text-xs text-muted">{k.assignee_name ?? "Allgemeiner Eingang"}</div></div>
                </div>
              ))}
            </section>
          )}

          {siblings.length > 0 && !t.merged_into && (
            <section className="card p-4 space-y-2" data-testid="merge">
              <h2 className="font-semibold text-navy">Weitere Tickets dieses Absenders</h2>
              <ul className="text-sm space-y-1">
                {siblings.map((x) => <li key={x.id}><Link className="text-navy underline" href={`/tickets/${x.id}`}>T-{x.id}</Link> · {x.subject || "(ohne Betreff)"} · <span className="text-muted">{x.status}</span></li>)}
              </ul>
              <form action={mergeAction.bind(null, ticketId)} className="flex gap-2">
                <select name="into" className="input" defaultValue={String(siblings[0].id)}>
                  {siblings.map((x) => <option key={x.id} value={String(x.id)}>T-{x.id}</option>)}
                </select>
                <button className="btn-ghost whitespace-nowrap">Hierhin zusammenführen</button>
              </form>
              <p className="text-xs text-muted">Dieses Ticket (T-{ticketId}) wird in das gewählte überführt; der Verlauf bleibt vollständig.</p>
            </section>
          )}

          <section className="card p-4 space-y-2 text-sm" data-testid="object-card">
            <h2 className="font-semibold text-navy">Objekt & Zuordnung</h2>
            {t.object_id ? <div><div className="font-medium text-ink">{t.object_title ?? t.object_id}</div><div className="text-xs text-muted">{t.object_id}{obj?.customer ? ` · ${obj.customer}` : ""}{obj?.stage ? ` · ${obj.stage}` : ""}</div></div>
              : <div className="text-muted">Kein Objekt erkannt.</div>}
            {obj?.am_name && <div className="text-xs text-muted">AM laut CRM: <span className="text-ink">{obj.am_name}</span>{obj.am_email ? ` (${obj.am_email})` : ""}</div>}
            {t.routing_source && <div className="text-xs text-muted">Zuordnung: {ROUTING[t.routing_source] ?? t.routing_source}</div>}
            {t.routing_note && !t.assignee_email && <div className="text-xs text-amber-700">{t.routing_note}</div>}
          </section>

          <section className="card p-4">
            <h2 className="font-semibold text-navy mb-3">Bewerber (live aus moovin)</h2>
            {!moovinOn && (
              <p className="text-sm text-amber-700" data-testid="moovin-off">moovin-Anbindung aus (Livetest): Bewerberdaten bitte direkt in moovin nachsehen. Vorgeschlagene Aktionen werden nach der Freigabe zu Aufgaben für den AM, nichts wird an moovin gesendet.</p>
            )}
            {ctxError && <p className="text-sm text-pink">moovin nicht erreichbar: {ctxError}</p>}
            {moovinOn && !ctx && !ctxError && (
              <p className="text-sm text-amber-700">Absender {t.sender_email} ist in moovin unbekannt. Die KI gibt keine persönlichen Daten heraus.</p>
            )}
            {ctx && (
              <div className="space-y-3 text-sm">
                <div>
                  <div className="font-medium">{ctx.applicant.salutation} {ctx.applicant.last_name}</div>
                  <div className="text-muted">{t.sender_email} · {ctx.applicant.id}</div>
                </div>
                {ctx.applications.map((a) => (
                  <div key={a.id} className="rounded-lg border border-line p-3 space-y-1.5">
                    <div className="font-medium text-ink">{a.object_title}</div>
                    <div className="text-xs text-muted">{a.listing_id} · {a.id} · {a.status}</div>
                    <div>{a.status_label}</div>
                    {a.missing_documents.length > 0 && (
                      <div className="text-xs"><span className="text-pink font-medium">Fehlt:</span> {a.missing_documents.join(", ")}</div>
                    )}
                    {a.appointment && (
                      <div className="text-xs text-muted">Termin {a.appointment.id}: {fmtLong(a.appointment.starts_at)} · {a.appointment.status}<br />{a.appointment.meeting_point}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="card p-4 text-xs text-muted space-y-1">
            <div className="font-semibold text-ink text-sm mb-1">Sicherheit</div>
            <div>{moovinOn ? "Antworten gehen nur an die in moovin hinterlegte Adresse." : "moovin-Anbindung aus: Antworten gehen an die Absenderadresse – persönliche Angaben nur nach Prüfung in moovin."}</div>
            <div>Claude sieht keine Anhänge und keine Scores.</div>
            {analysis.toolCalls && analysis.toolCalls.length > 0 && <div>KI-Werkzeuge: {analysis.toolCalls.join(", ")}</div>}
            <div>Deep-Link aus moovin: <code>/tickets?email={t.sender_email}</code></div>
          </section>
        </aside>
      </div>
    </div>
  );
}
