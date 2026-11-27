import "server-only";
import { sql } from "./db";
import { audit } from "./audit";
import { env } from "./env";
import { dueDate, addWorkingHours } from "./sla";
import { followUpTasks, type Signal } from "./signals";

/** Heutiges Datum in Berlin (YYYY-MM-DD). */
export function berlinToday(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

type AgentRow = { email: string; active: boolean; absent_from: string | null; absent_until: string | null; deputy_email: string | null };

function isAbsent(a: AgentRow, today: string) {
  return !!a.absent_from && !!a.absent_until && a.absent_from <= today && today <= a.absent_until;
}

/**
 * Wer bearbeitet Tickets dieses AM gerade? Abwesend → Vertretung (aktiv und selbst anwesend), sonst Allgemeiner Eingang (null).
 * deputyFor = vertretener AM (für die Anzeige „Vertretung für …“).
 */
export async function effectiveAssignee(email: string | null): Promise<{ assignee: string | null; deputyFor: string | null }> {
  if (!email) return { assignee: null, deputyFor: null };
  const rows = await sql<AgentRow[]>`select email, active, absent_from::text, absent_until::text, deputy_email from ticket.agents where active`;
  const by = new Map(rows.map((r) => [r.email, r]));
  const today = berlinToday();
  const am = by.get(email);
  if (!am) return { assignee: null, deputyFor: null };
  if (!isAbsent(am, today)) return { assignee: email, deputyFor: null };
  const dep = am.deputy_email ? by.get(am.deputy_email) : undefined;
  if (dep && !isAbsent(dep, today)) return { assignee: dep.email, deputyFor: email };
  return { assignee: null, deputyFor: email };
}

// ---------- Aufgaben ----------

export type TaskType = "verschiebewunsch" | "rueckzug" | "interesse" | "notiz" | "nachfassen" | "manuell" | "unterlagen_pruefen" | "slot_nachbesetzen" | "kandidat_aktivieren";

/**
 * Grundsatz: höchstens EINE offene Aufgabe je Ticket. Gibt es schon eine, wird der neue Punkt als Zeile angehängt
 * (eine Checkliste je Ticket); Priorität und Fälligkeit werden auf das Dringendste gesetzt, der wichtigste Punkt steht oben.
 * Bei erneuter Verarbeitung (Neu generieren, Folgemail im Thread, Senden mit Aktionen) wird die bestehende Aufgabe
 * aktualisiert statt eine neue angelegt. Ein Punkt, der schon in der Aufgabe steht, wird nicht noch einmal angehängt.
 */
export async function createTask(t: { ticketId: number; type: TaskType; text: string; assignee: string | null; actionId?: number | null; createdBy?: string; due?: Date; priority?: number;
  /** Zeile, die mit diesem Anfang beginnt, wird ersetzt statt ergänzt (z. B. „Unterlagen prüfen“ aus der Aktion → Hochstufung aus dem Signal) */
  mergeHead?: string }) {
  const line = t.text.replace(/\s+/g, " ").trim().slice(0, 600);
  const priority = t.priority ?? 3;
  const due = t.due ?? dueDate(new Date());
  const by = t.createdBy ?? "system";
  // Idempotenz je Aktion (z. B. Aktion zweimal ausgeführt): der Punkt dieser Aktion existiert schon
  if (t.actionId && (await sql`select 1 from ticket.tasks where action_id = ${t.actionId}`).length) return null;
  const [open] = await sql`select id, text, priority, type from ticket.tasks where ticket_id = ${t.ticketId} and status = 'offen' order by id limit 1 for update`;
  if (open) {
    const lines = String(open.text).split("\n").map((l) => l.trim().replace(/^•\s*/, "")).filter(Boolean);
    const has = lines.some((l) => l === line);
    if (!has) {
      // Dringenderer Punkt kommt nach oben (bestimmt Titel und Typ), sonst ans Ende der Liste
      const head = t.mergeHead?.trim();
      const items = head ? lines.filter((l) => !l.startsWith(head)) : lines;
      const newItems = priority < Number(open.priority) ? [line, ...items] : [...items, line];
      const text = newItems.map((l, i) => (i === 0 ? l : `• ${l}`)).join("\n").slice(0, 2000);
      const type = priority < Number(open.priority) ? t.type : open.type;
      await sql`update ticket.tasks set text = ${text}, type = ${type}, priority = least(priority, ${priority}),
                due_at = least(coalesce(due_at, ${due}), ${due}), assignee_email = coalesce(assignee_email, ${t.assignee}) where id = ${open.id}`;
      await audit(by, "ticket", { event: "aufgabe_ergaenzt", type: t.type, task: Number(open.id) }, t.ticketId);
    }
    return Number(open.id);
  }
  const [row] = await sql`insert into ticket.tasks (ticket_id, action_id, assignee_email, type, text, due_at, created_by, priority)
    values (${t.ticketId}, ${t.actionId ?? null}, ${t.assignee}, ${t.type}, ${line}, ${due}, ${by}, ${priority})
    on conflict (action_id) do nothing returning id`;
  if (row) await audit(by, "ticket", { event: "aufgabe_angelegt", type: t.type, task: Number(row.id) }, t.ticketId);
  return row ? Number(row.id) : null;
}

/** Nach erfolgreicher Aktion: Punkt in der Aufgabe des Tickets, wenn der AM in moovin etwas tun muss. */
export async function taskForAction(a: { id: number; ticket_id: number; type: string; payload: { interest?: string; text?: string; manual?: boolean }; label: string | null; assignee_email: string | null }) {
  let type: TaskType | null = null;
  let text = "";
  const manual = !!a.payload.manual; // moovin-Anbindung aus: der AM trägt es selbst in moovin ein
  if (a.type === "termin_verschieben_wunsch") { type = "verschiebewunsch"; text = `Neuen Termin anbieten: ${a.label ?? ""}`; }
  else if (a.type === "interesse_setzen" && a.payload.interest === "zurueckgezogen") { type = "rueckzug"; text = "Bewerbung in moovin zurückziehen (Bewerber hat per Mail zurückgezogen)"; }
  else if (a.type === "interesse_setzen") { type = "interesse"; text = manual ? "Anmietwunsch/Interesse in moovin vermerken und an den Vermieter weitergeben" : "Interesse des Bewerbers in moovin vermerken"; }
  else if (a.type === "notiz") { type = "notiz"; text = `${manual ? "Notiz in moovin eintragen" : "Notiz in moovin prüfen"}: ${String(a.payload.text ?? "").slice(0, 300)}`; }
  else if (manual && a.type === "dokumente_ablegen") { type = "manuell"; text = "Anhänge aus dem Ticket in moovin am Bewerber ablegen"; }
  else if (manual && a.type === "termin_bestaetigen") { type = "manuell"; text = "Teilnahme am Besichtigungstermin in moovin bestätigen"; }
  else if (manual && a.type === "termin_absagen") { type = "manuell"; text = "Besichtigungstermin in moovin absagen und Platz freigeben"; }
  if (!type) return null;
  return createTask({ ticketId: a.ticket_id, type, text, assignee: a.assignee_email, actionId: a.id });
}

/**
 * Ticket-Intelligenz, Fall B: Die Antwort ist raus, die Arbeit bleibt (Unterlagen prüfen, Slot nachbesetzen, nächsten Kandidaten aktivieren).
 * Der Punkt landet in der einen Aufgabe des Tickets und stuft sie hoch; gibt es noch keine, entsteht bei Auto-Antworten
 * eine neue, markierte Aufgabe ganz oben in „Offene Aufgaben“.
 */
export async function signalTasks(ticketId: number, createNew: boolean) {
  const [t] = await sql`select assignee_email, intent, signals from ticket.tickets where id = ${ticketId}`;
  if (!t) return;
  for (const f of followUpTasks((t.signals ?? []) as Signal[], t.intent)) {
    const due = addWorkingHours(new Date(), f.priority === 1 ? 2 : 4);
    const [open] = await sql`select id from ticket.tasks where ticket_id = ${ticketId} and status = 'offen' limit 1`;
    if (open || createNew) await createTask({ ticketId, type: f.type, text: f.text, assignee: t.assignee_email, priority: f.priority, due, createdBy: "ki", mergeHead: f.text.split(" – ")[0] });
  }
}

/** Wiedereröffnen durch den AM (Reiter „Erledigt“): beantwortete oder geschlossene Tickets zurück in die Bearbeitung. */
export async function reopenTicket(ticketId: number, actor: string) {
  const [t] = await sql`update ticket.tickets set status = 'in_bearbeitung', reopened_at = now(), closed_at = null, auto_handled = false,
            waiting_since = null, waiting_reminded_at = null, due_at = coalesce(due_at, ${dueDate(new Date())}), updated_at = now()
            where id = ${ticketId} and status in ('beantwortet','geschlossen','wartet') and merged_into is null returning id`;
  if (!t) throw new Error("Ticket kann nicht wiedereröffnet werden");
  await addNote(ticketId, actor.replace(/^am:/, ""), "Ticket manuell wiedereröffnet.", "system");
  await audit(actor, "ticket", { event: "wiedereroeffnet", manuell: true }, ticketId);
}

export async function setTaskDone(taskId: number, actor: string, done: boolean) {
  const [t] = await sql`update ticket.tasks set status = ${done ? "erledigt" : "offen"}, done_by = ${done ? actor : null}, done_at = ${done ? new Date() : null}
                        where id = ${taskId} returning ticket_id`;
  if (t) await audit(actor, "ticket", { event: done ? "aufgabe_erledigt" : "aufgabe_wieder_offen", task: taskId }, Number(t.ticket_id));
}

// ---------- Interne Notizen ----------

export async function addNote(ticketId: number, author: string, text: string, kind: "notiz" | "weitergabe" | "system" = "notiz", target: string | null = null) {
  await sql`insert into ticket.notes (ticket_id, author_email, kind, target_email, text) values (${ticketId}, ${author}, ${kind}, ${target}, ${text.slice(0, 4000)})`;
}

// ---------- Zusammenführen ----------

/** Führt source in target zusammen (gleicher Absender). Nachrichten, Notizen, Aufgaben wandern mit; source wird geschlossen. */
export async function mergeTickets(sourceId: number, targetId: number, actor: string) {
  if (sourceId === targetId) throw new Error("Gleiches Ticket");
  const [s] = await sql`select id, sender_email, merged_into from ticket.tickets where id = ${sourceId}`;
  const [t] = await sql`select id, sender_email, merged_into from ticket.tickets where id = ${targetId}`;
  if (!s || !t) throw new Error("Ticket nicht gefunden");
  if (s.merged_into || t.merged_into) throw new Error("Ticket wurde bereits zusammengeführt");
  if (s.sender_email !== t.sender_email) throw new Error("Nur Tickets desselben Absenders");
  await sql.begin(async (tx) => {
    await tx`update ticket.messages set ticket_id = ${targetId} where ticket_id = ${sourceId}`;
    await tx`update ticket.notes set ticket_id = ${targetId} where ticket_id = ${sourceId}`;
    await tx`update ticket.tasks set ticket_id = ${targetId} where ticket_id = ${sourceId}`;
    await tx`update ticket.drafts set status = 'verworfen', decided_by = ${actor}, decided_at = now() where ticket_id = ${sourceId} and status = 'offen'`;
    await tx`update ticket.actions set status = 'verworfen' where ticket_id = ${sourceId} and status in ('vorgeschlagen','blockiert')`;
    await tx`update ticket.tickets set status = 'geschlossen', closed_at = now(), merged_into = ${targetId}, updated_at = now() where id = ${sourceId}`;
    await tx`update ticket.tickets set last_inbound_at = greatest(last_inbound_at, (select max(created_at) from ticket.messages where ticket_id = ${targetId} and direction = 'in')),
             updated_at = now() where id = ${targetId}`;
    await tx`insert into ticket.notes (ticket_id, author_email, kind, text) values (${targetId}, ${actor.replace(/^am:/, "")}, 'system', ${`T-${sourceId} wurde in dieses Ticket zusammengeführt.`})`;
  });
  await audit(actor, "ticket", { event: "zusammengefuehrt", from: sourceId, into: targetId }, targetId);
  await audit(actor, "ticket", { event: "zusammengefuehrt", from: sourceId, into: targetId }, sourceId);
}

// ---------- Bearbeitungssperre (Anzeige) ----------

export async function touchPresence(ticketId: number, email: string) {
  await sql`insert into ticket.presence (ticket_id, agent_email, seen_at) values (${ticketId}, ${email}, now())
            on conflict (ticket_id, agent_email) do update set seen_at = now()`;
}

export async function othersViewing(ticketId: number, email: string): Promise<{ email: string; name: string }[]> {
  return sql<{ email: string; name: string }[]>`select p.agent_email as email, a.name from ticket.presence p join ticket.agents a on a.email = p.agent_email
    where p.ticket_id = ${ticketId} and p.agent_email <> ${email} and p.seen_at > now() - interval '60 seconds' order by a.name`;
}

export async function leavePresence(ticketId: number, email: string) {
  await sql`delete from ticket.presence where ticket_id = ${ticketId} and agent_email = ${email}`;
}

// ---------- Tägliche Pflege (Vercel Cron, zusätzlich beim Öffnen von „Mein Bereich“) ----------

export const WAIT_DAYS = 7;

export async function housekeeping(actor = "system") {
  // 1. Wartet seit 7 Tagen ohne Antwort → Hinweis-Aufgabe an den AM (keine Mail an den Bewerber); Testtickets nie
  const stale = await sql`update ticket.tickets set waiting_reminded_at = now()
    where status = 'wartet' and waiting_reminded_at is null and waiting_since < now() - make_interval(days => ${WAIT_DAYS}) and not is_test
    returning id, assignee_email`;
  for (const t of stale) {
    await createTask({ ticketId: Number(t.id), type: "nachfassen", assignee: t.assignee_email, createdBy: actor,
      text: `Seit ${WAIT_DAYS} Tagen keine Antwort des Bewerbers auf die Rückfrage – nachfassen (Antwort im Ticket) oder Ticket schließen.` });
  }

  // 2. Abwesenheit: offene Tickets und Aufgaben abwesender AMs → Vertretung bzw. Allgemeiner Eingang
  const today = berlinToday();
  const absent = await sql`select email from ticket.agents where active and absent_from <= ${today}::date and absent_until >= ${today}::date`;
  let moved = 0;
  for (const a of absent) {
    const { assignee, deputyFor } = await effectiveAssignee(a.email);
    const tickets = await sql`update ticket.tickets set assignee_email = ${assignee}, deputy_for = ${deputyFor}, updated_at = now()
      where assignee_email = ${a.email} and status not in ('beantwortet','geschlossen') returning id`;
    await sql`update ticket.tasks set assignee_email = ${assignee} where assignee_email = ${a.email} and status = 'offen'`;
    for (const t of tickets) {
      await audit(actor, "ticket", { event: "vertretung", from: a.email, to: assignee ?? "Allgemeiner Eingang" }, Number(t.id));
      moved++;
    }
  }

  // 3. Abwesenheit vorbei: Tickets, die mangels Vertretung im Allgemeinen Eingang lagen, gehen zurück an den AM
  const back = await sql`update ticket.tickets t set assignee_email = t.deputy_for, deputy_for = null, updated_at = now()
    from ticket.agents a
    where a.email = t.deputy_for and a.active and t.assignee_email is null and t.status not in ('beantwortet','geschlossen')
      and not (coalesce(a.absent_from <= ${today}::date and a.absent_until >= ${today}::date, false))
    returning t.id, t.assignee_email`;
  for (const t of back) await audit(actor, "ticket", { event: "zurueck_nach_abwesenheit", to: t.assignee_email }, Number(t.id));

  // 4. Aufräumen
  await sql`delete from ticket.presence where seen_at < now() - interval '1 hour'`;
  await sql`delete from ticket.oauth_states where created_at < now() - interval '1 hour'`;
  await sql`delete from ticket.sessions where expires_at < now()`;
  return { reminders: stale.length, moved, back: back.length };
}

// Pflege beim Öffnen von „Mein Bereich“: höchstens alle 10 Minuten je Instanz (sonst täglich per Cron)
const hk = globalThis as unknown as { __hk?: number };
export async function maybeHousekeeping() {
  const now = Date.now();
  if (hk.__hk && now - hk.__hk < 10 * 60_000) return;
  hk.__hk = now;
  await housekeeping("system").catch((e) => console.error("housekeeping", e));
}

/**
 * Löschkonzept (DSGVO): abgeschlossene Tickets ohne Aktivität seit `RETENTION_MONTHS` Monaten (Standard 6) endgültig löschen –
 * mit Nachrichten, Anhängen, Entwürfen, Aktionen, Aufgaben, Notizen und Signal-Rückmeldungen (alles per ON DELETE CASCADE).
 * Offene Tickets bleiben immer erhalten. Das Audit-Log bleibt (insert-only) und enthält nur die Ticket-Nummer.
 * Läuft nur im täglichen Cron, in Paketen, damit keine langen Sperren entstehen.
 */
export async function purgeExpiredTickets(actor = "cron", batch = 500): Promise<{ deleted: number; months: number }> {
  const months = env.retentionMonths();
  if (months === 0) return { deleted: 0, months };
  let deleted = 0;
  for (let round = 0; round < 20; round++) {
    const n = await sql.begin(async (tx) => {
      const doomed = await tx`select id from ticket.tickets
        where status in ('beantwortet','geschlossen')
          and greatest(updated_at, coalesce(closed_at, updated_at), coalesce(last_inbound_at, updated_at)) < now() - make_interval(months => ${months})
        order by id limit ${batch} for update skip locked`;
      if (doomed.length === 0) return 0;
      const ids = doomed.map((r) => Number(r.id));
      // Verweise „zusammengeführt in“ auf zu löschende Tickets lösen (sonst blockiert der Fremdschlüssel)
      await tx`update ticket.tickets set merged_into = null where merged_into = any(${ids}::bigint[]) and not (id = any(${ids}::bigint[]))`;
      await tx`delete from ticket.tickets where id = any(${ids}::bigint[])`;
      return ids.length;
    });
    deleted += n;
    if (n < batch) break;
  }
  if (deleted > 0) await audit(actor, "ticket", { event: "loeschung", tickets: deleted, monate: months });
  return { deleted, months };
}
