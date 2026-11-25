"use server";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { requireAgent, canSeeTicket } from "@/lib/auth";
import { sendDraft, analyzeTicket, closeTicket, SendConflict } from "@/lib/pipeline";
import { audit } from "@/lib/audit";
import { addNote, mergeTickets, touchPresence, othersViewing, leavePresence, setTaskDone, effectiveAssignee } from "@/lib/workflow";

async function guard(ticketId: number) {
  const agent = await requireAgent();
  const [t] = await sql`select assignee_email, due_at, status from ticket.tickets where id = ${ticketId}`;
  if (!t || !(await canSeeTicket(agent, t as never))) throw new Error("Kein Zugriff");
  return agent;
}

export async function sendAction(ticketId: number, draftId: number, text: string, actionIds: number[], opts: { awaitReply: boolean; knownLastMessageId: number | null; force?: boolean }) {
  const agent = await guard(ticketId);
  try {
    const r = await sendDraft({ ticketId, draftId, actor: `am:${agent.email}`, finalText: text, actionIds, awaitReply: opts.awaitReply, knownLastMessageId: opts.knownLastMessageId, force: opts.force });
    revalidatePath(`/tickets/${ticketId}`);
    const failed = r.results.filter((x) => !x.ok);
    return { ok: true, conflict: false, message: `Antwort ${r.delivery === "simuliert" ? "(simuliert) " : ""}versendet${opts.awaitReply ? " – wartet auf Antwort des Bewerbers" : ""}${r.results.length ? `, ${r.results.length - failed.length}/${r.results.length} Aktionen ausgeführt` : ""}.`, failed };
  } catch (e) {
    return { ok: false, conflict: e instanceof SendConflict, message: (e as Error).message, failed: [] };
  }
}

export async function regenerateAction(ticketId: number) {
  const agent = await guard(ticketId);
  await analyzeTicket(ticketId, `am:${agent.email}`);
  revalidatePath(`/tickets/${ticketId}`);
}

export async function closeAction(ticketId: number) {
  const agent = await guard(ticketId);
  await closeTicket(ticketId, `am:${agent.email}`);
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/mein");
}

export async function takeOverAction(ticketId: number) {
  const agent = await guard(ticketId);
  await sql`update ticket.tickets set assignee_email = ${agent.email}, deputy_for = null, updated_at = now() where id = ${ticketId}`;
  await audit(`am:${agent.email}`, "ticket", { event: "übernommen" }, ticketId);
  revalidatePath(`/tickets/${ticketId}`);
}

/** Zuordnung: Objekt und/oder AM. Ohne AM-Auswahl bleibt der zugeordnete AM; im Allgemeinen Eingang → AM, der das Objekt zuletzt betreut hat. */
export async function assignAction(ticketId: number, form: FormData) {
  const agent = await guard(ticketId);
  const email = String(form.get("to") ?? "").trim().toLowerCase();
  const objectRaw = String(form.get("object") ?? "").trim();
  const [cur] = await sql`select object_id, object_title, assignee_email, deputy_for from ticket.tickets where id = ${ticketId}`;

  let objectId: string | null = cur.object_id, objectTitle: string | null = cur.object_title;
  if (objectRaw) {
    // Eingabe „OBJ-ID · Titel“ aus der Liste oder freie Objekt-ID
    const id = objectRaw.split(" · ")[0].trim();
    const [crmObj] = await sql`select object_id, title from ticket.crm_objects where upper(object_id) = upper(${id})`;
    const [known] = await sql`select object_id, object_title from ticket.tickets where object_id = ${id} and object_title is not null order by created_at desc limit 1`;
    objectId = crmObj?.object_id ?? id;
    objectTitle = crmObj?.title ?? known?.object_title ?? (objectRaw.includes(" · ") ? objectRaw.split(" · ").slice(1).join(" · ") : cur.object_title);
  }

  let target: string | null = email ? (await sql`select email from ticket.agents where email = ${email} and active`)[0]?.email ?? null : null;
  // Kein AM gewählt: zugeordneter AM bleibt; ohne AM übernimmt der AM, der das Objekt zuletzt betreut hat
  if (!email && cur.assignee_email) target = cur.assignee_email;
  else if (!email && objectId) {
    // AM laut CRM (falls im Ticketsystem freigeschaltet), sonst der AM, der das Objekt zuletzt betreut hat
    const [crmAm] = await sql`select a.email from ticket.crm_objects o join ticket.agents a on a.email = o.am_email and a.active where o.object_id = ${objectId}`;
    const [last] = crmAm ? [] : await sql`select assignee_email from ticket.tickets where object_id = ${objectId} and assignee_email is not null and id <> ${ticketId}
                             order by updated_at desc limit 1`;
    target = crmAm?.email ?? last?.assignee_email ?? null;
  }
  const eff = target ? await effectiveAssignee(target) : { assignee: null, deputyFor: null };
  if (eff.assignee && eff.assignee === cur.assignee_email && !eff.deputyFor) eff.deputyFor = cur.deputy_for;

  await sql`update ticket.tickets set assignee_email = ${eff.assignee}, deputy_for = ${eff.deputyFor}, object_id = ${objectId}, object_title = ${objectTitle},
            routing_source = ${eff.assignee ? "manuell" : null}, routing_note = null, updated_at = now() where id = ${ticketId}`;
  await audit(`am:${agent.email}`, "ticket", { event: "zugeordnet", object: objectId, to: eff.assignee ?? "Allgemeiner Eingang", deputy_for: eff.deputyFor }, ticketId);
  revalidatePath(`/tickets/${ticketId}`);
}

export async function addNoteAction(ticketId: number, form: FormData) {
  const agent = await guard(ticketId);
  const text = String(form.get("text") ?? "").trim();
  if (!text) return;
  await addNote(ticketId, agent.email, text, "notiz");
  await audit(`am:${agent.email}`, "ticket", { event: "interne_notiz" }, ticketId);
  revalidatePath(`/tickets/${ticketId}`);
}

/** Weitergabe an einen Kollegen mit Kommentar (interne Notiz). */
export async function handoverAction(ticketId: number, form: FormData) {
  const agent = await guard(ticketId);
  const to = String(form.get("to") ?? "").trim().toLowerCase();
  const text = String(form.get("text") ?? "").trim();
  const [target] = await sql`select email, name from ticket.agents where email = ${to} and active`;
  if (!target || to === agent.email) throw new Error("Kollege nicht gefunden");
  const eff = await effectiveAssignee(target.email);
  await sql`update ticket.tickets set assignee_email = ${eff.assignee}, deputy_for = ${eff.deputyFor}, updated_at = now() where id = ${ticketId}`;
  await addNote(ticketId, agent.email, text || "Bitte übernehmen.", "weitergabe", target.email);
  await audit(`am:${agent.email}`, "ticket", { event: "weitergegeben", to: eff.assignee ?? "Allgemeiner Eingang", wanted: target.email }, ticketId);
  revalidatePath(`/tickets/${ticketId}`);
}

export async function mergeAction(ticketId: number, form: FormData) {
  const agent = await guard(ticketId);
  const target = Number(String(form.get("into") ?? "").replace(/\D/g, ""));
  await guard(target);
  await mergeTickets(ticketId, target, `am:${agent.email}`);
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath(`/tickets/${target}`);
}

/** Ticket-Intelligenz: „Markierung passt nicht“ – Signal am Ticket verwerfen, Stufe neu setzen, Trefferquote zählen. */
export async function signalFeedbackAction(ticketId: number, form: FormData) {
  const agent = await guard(ticketId);
  const signal = String(form.get("signal") ?? "");
  const [t] = await sql`select signals from ticket.tickets where id = ${ticketId}`;
  const signals = ((t?.signals ?? []) as { type: string; stage: number }[]);
  if (!signals.some((x) => x.type === signal)) return;
  await sql`insert into ticket.signal_feedback (ticket_id, signal, agent_email) values (${ticketId}, ${signal}, ${agent.email}) on conflict do nothing`;
  const rest = signals.filter((x) => x.type !== signal);
  const top = Math.min(9, ...rest.filter((x) => x.stage <= 2).map((x) => x.stage));
  const priority = top <= 2 ? top : rest.some((x) => x.stage === 4) ? 4 : 3;
  await sql`update ticket.tickets set signals = ${sql.json(rest as never)}, priority = ${priority}, updated_at = now() where id = ${ticketId}`;
  await audit(`am:${agent.email}`, "ticket", { event: "markierung_passt_nicht", signal, priority }, ticketId);
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/mein");
}

export async function reviewedAction(ticketId: number) {
  const agent = await guard(ticketId);
  await sql`update ticket.tickets set reviewed_at = now(), reviewed_by = ${agent.email} where id = ${ticketId} and auto_handled`;
  await audit(`am:${agent.email}`, "ticket", { event: "gegengelesen" }, ticketId);
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath("/mein");
}

export async function taskDoneAction(taskId: number, done: boolean) {
  const agent = await requireAgent();
  const [t] = await sql`select k.ticket_id, k.assignee_email, t.assignee_email as ticket_assignee, t.due_at, t.status from ticket.tasks k join ticket.tickets t on t.id = k.ticket_id where k.id = ${taskId}`;
  if (!t) throw new Error("Aufgabe nicht gefunden");
  if (agent.role !== "admin" && t.assignee_email !== agent.email && !(await canSeeTicket(agent, { assignee_email: t.ticket_assignee, due_at: t.due_at, status: t.status }))) throw new Error("Kein Zugriff");
  await setTaskDone(taskId, `am:${agent.email}`, done);
  revalidatePath("/mein");
  revalidatePath(`/tickets/${t.ticket_id}`);
}

/** Bearbeitungssperre: Herzschlag alle 20 s; liefert, wer das Ticket sonst gerade offen hat. */
export async function presenceAction(ticketId: number, leaving = false) {
  const agent = await guard(ticketId);
  if (leaving) { await leavePresence(ticketId, agent.email); return { others: [], lastOutId: null }; }
  await touchPresence(ticketId, agent.email);
  const [last] = await sql`select max(id) as id from ticket.messages where ticket_id = ${ticketId} and direction = 'out'`;
  return { others: await othersViewing(ticketId, agent.email), lastOutId: last?.id ? Number(last.id) : null };
}
