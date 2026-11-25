import "server-only";
import { randomBytes } from "node:crypto";
import { sql } from "./db";
import { env, demoMode } from "./env";
import { audit } from "./audit";
import { MoovinClient } from "./moovin/client";
import type { ApplicantContext } from "./moovin/types";
import { isSenderVerified } from "./inbound/dkim";
import { stripQuoted, type InboundMail } from "./inbound/parse";
import { dueDate } from "./sla";
import { searchKnowledge } from "./knowledge";
import { runClaudeAgent } from "./ai/claude";
import { runDemoAgent } from "./ai/demo";
import type { AgentInput, AgentOutput, ProposedAction } from "./ai/types";
import { sendMail, sendMailDetailed } from "./mailer";
import { similarity, UNCHANGED_THRESHOLD } from "./similarity";
import { INTENTS, type ActionType } from "./intents";
import { resolveAppointment } from "./appointments";
import { copyCorrespondence } from "./correspondence";
import { effectiveAssignee, taskForAction, addNote } from "./workflow";
import { moovinEnabled } from "./settings";
import { recognizeObject } from "./crm/objects";
import type { ObjectMatch } from "./crm/match";

const WRITE_ACTIONS: ActionType[] = ["dokumente_ablegen", "termin_bestaetigen", "termin_absagen", "termin_verschieben_wunsch", "interesse_setzen", "notiz", "datenschutz_weiterleiten"];
// Interne Weiterleitung (kein Schreibzugriff auf moovin): auch bei unbekanntem oder nicht verifiziertem Absender erlaubt.
// Das Datenschutzteam prüft die Identität selbst; der Verifizierungsstatus steht in der Weiterleitung.
const INTERNAL_ACTIONS: ActionType[] = ["datenschutz_weiterleiten"];
// Aktionen, die nichts in moovin schreiben (nur Mail aus dem Ticketsystem) → kein bestätigter Absender nötig
const NO_MOOVIN_WRITE: ActionType[] = ["datenschutz_weiterleiten", "termin_verschieben_wunsch"];
// moovin-Anbindung aus: diese Aktionen werden nicht an moovin gesendet, sondern als Aufgabe für den AM angelegt
const MANUAL_ACTIONS: ActionType[] = ["dokumente_ablegen", "termin_bestaetigen", "termin_absagen", "termin_verschieben_wunsch", "interesse_setzen", "notiz"];
// Allgemeine Anliegen ohne Bewerberbezug: dürfen auch ohne moovin-Daten automatisch beantwortet werden (wenn der Intent auf Auto steht)
const GENERAL_INTENTS = ["wohnungssuche_allgemein", "konto_datenschutz", "technik_login"];

function newMessageId(ticketId: number) {
  return `<ticket-${ticketId}-${randomBytes(6).toString("hex")}@tickets.moovin.de>`;
}

// System-/interne Absender (Auswertung Zoho-Desk-Export: ~18 % der Tickets) → keine KI, direkt an Menschen
const SYSTEM_SENDER = /^(no-?reply|noreply|mailer-daemon|postmaster|bounce)[^@]*@|@(moovin\.de|moovinimmobilien\.zohodesk\.com)$|@immobilienscout24\.de$/i;

function trustedAuthServ(): string[] {
  return (process.env.TRUSTED_AUTHSERV_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------- Eingang ----------

export async function processInbound(mail: InboundMail, actor = "webhook", warnings: string[] = []): Promise<{ ticketId: number; duplicate: boolean }> {
  if (!mail.fromEmail || !mail.fromEmail.includes("@")) throw new Error("Absender fehlt");

  if (mail.messageId) {
    const dup = await sql`select ticket_id from ticket.messages where mail_message_id = ${mail.messageId} and direction = 'in'`;
    if (dup.length) return { ticketId: Number(dup[0].ticket_id), duplicate: true };
  }

  const verification = isSenderVerified(mail.authResults, mail.fromEmail, trustedAuthServ());
  const now = new Date();

  // Threading: 1) eigene/vom Versanddienst vergebene Message-ID in In-Reply-To/References, 2) [#T-123] im Betreff,
  // 3) offenes Ticket desselben Absenders < 14 Tage. Geschlossene Tickets werden über 1) und 2) wieder geöffnet.
  let ticketId: number | null = null;
  const refs = `${mail.inReplyTo ?? ""} ${mail.references ?? ""}`;
  const refMatch = refs.match(/ticket-(\d+)-[0-9a-f]+@tickets\.moovin\.de/);
  const refIds = (refs.match(/<[^<>\s]+>/g) ?? []).slice(-20);
  let byProvider: string | undefined;
  if (refIds.length) {
    const r = await sql`select ticket_id from ticket.messages where direction = 'out' and (mail_message_id = any(${refIds}) or provider_message_id = any(${refIds}))
                        order by created_at desc limit 1`;
    byProvider = r[0]?.ticket_id ? String(r[0].ticket_id) : undefined;
  }
  const subjMatch = mail.subject.match(/\[#T-(\d+)\]/);
  for (const cand of [refMatch?.[1], byProvider, subjMatch?.[1]]) {
    if (!cand) continue;
    const t = await sql`select id, merged_into from ticket.tickets where id = ${Number(cand)} and sender_email = ${mail.fromEmail}`;
    if (t.length) { ticketId = Number(t[0].merged_into ?? t[0].id); break; }
  }
  if (!ticketId) {
    const t = await sql`select id from ticket.tickets where sender_email = ${mail.fromEmail} and status <> 'geschlossen' and merged_into is null
                        and created_at > now() - interval '14 days' order by created_at desc limit 1`;
    if (t.length) ticketId = Number(t[0].id);
  }

  if (!ticketId) {
    const [t] = await sql`insert into ticket.tickets (sender_email, sender_name, subject, sender_verified, due_at, last_inbound_at)
      values (${mail.fromEmail}, ${mail.fromName || null}, ${mail.subject || null}, ${verification.verified}, ${dueDate(now)}, ${now}) returning id`;
    ticketId = Number(t.id);
  } else {
    const [prev] = await sql`select status from ticket.tickets where id = ${ticketId}`;
    await sql`update ticket.tickets set status = 'neu', sender_verified = ${verification.verified}, last_inbound_at = ${now},
              due_at = case when status in ('beantwortet','geschlossen','wartet') then ${dueDate(now)} else due_at end,
              reopened_at = case when status = 'geschlossen' then ${now} else reopened_at end,
              waiting_since = null, waiting_reminded_at = null, closed_at = null, updated_at = now() where id = ${ticketId}`;
    if (prev?.status === "geschlossen") {
      await audit(actor, "ticket", { event: "wiedereroeffnet" }, ticketId);
      await addNote(ticketId, "system", "Neue Mail des Bewerbers – Ticket wurde wieder geöffnet.", "system");
    } else if (prev?.status === "wartet") {
      await audit(actor, "ticket", { event: "antwort_auf_rueckfrage" }, ticketId);
    }
  }

  const [msg] = await sql`insert into ticket.messages (ticket_id, direction, from_email, from_name, to_email, subject, body_text,
      mail_message_id, in_reply_to, references_hdr, auth_results, sender_verified)
    values (${ticketId}, 'in', ${mail.fromEmail}, ${mail.fromName || null}, ${mail.to || env.inboundAddress()}, ${mail.subject || null}, ${mail.text},
      ${mail.messageId}, ${mail.inReplyTo}, ${mail.references}, ${mail.authResults}, ${verification.verified}) returning id`;

  for (const a of mail.attachments) {
    await sql`insert into ticket.attachments (message_id, filename, content_type, size_bytes, content)
              values (${msg.id}, ${a.filename}, ${a.contentType}, ${a.size}, ${Buffer.from(a.contentBase64, "base64")})`;
  }
  await audit(actor, "mail_in", { from: mail.fromEmail, attachments: mail.attachments.length, verified: verification.verified, detail: verification.detail }, ticketId);

  await analyzeTicket(ticketId, "system", warnings);
  return { ticketId, duplicate: false };
}

// ---------- KI-Analyse ----------

export async function analyzeTicket(ticketId: number, actor = "system", warnings: string[] = []) {
  const [ticket] = await sql`select * from ticket.tickets where id = ${ticketId}`;
  if (!ticket) throw new Error("Ticket nicht gefunden");
  const msgs = await sql`select * from ticket.messages where ticket_id = ${ticketId} order by created_at asc`;
  const lastIn = [...msgs].reverse().find((m) => m.direction === "in");
  if (!lastIn) return;
  const atts = await sql`select filename, content_type from ticket.attachments where message_id = ${lastIn.id}`;

  if (SYSTEM_SENDER.test(ticket.sender_email)) {
    await sql`update ticket.tickets set intent = 'intern_system', confidence = null, summary = 'System- oder interne Absenderadresse – keine KI-Verarbeitung.',
              needs_human = true, needs_human_reason = 'System-/interne Mail', status = 'neu', updated_at = now() where id = ${ticketId}`;
    await audit("system", "ticket", { event: "system_absender_uebersprungen" }, ticketId);
    return;
  }

  const moovinOn = await moovinEnabled();
  const client = new MoovinClient(ticket.sender_email, ticketId);
  let ctx: ApplicantContext | null = null;
  let moovinError: string | null = null;
  if (moovinOn) {
    try { ctx = await client.getApplicantContext(); } catch (e) { moovinError = (e as Error).message; }
  }

  // Objekt-Erkennung aus dem CRM (moovin-ID oder Adresse in Betreff/Text inkl. Zitat), wenn moovin keinen AM liefert
  const moovinAm = ctx?.applications.find((a) => a.account_manager_email)?.account_manager_email ?? null;
  let crm: ObjectMatch | null = null;
  if (!moovinAm) {
    const inbound = msgs.filter((m) => m.direction === "in").slice(-5).map((m) => `${m.subject ?? ""}\n${m.body_text ?? ""}`).join("\n");
    crm = await recognizeObject(inbound).catch(() => null);
  }

  const allowedListings = new Set((ctx?.applications ?? []).map((a) => a.listing_id));
  const objectTitle: string | null = ctx?.applications[0]?.object_title ?? null;
  const listingId: string | null = ctx?.applications[0]?.listing_id ?? null;

  const input: AgentInput = {
    ticketId,
    senderEmail: ticket.sender_email,
    senderName: ticket.sender_name ?? "",
    subject: lastIn.subject ?? "",
    newMessage: stripQuoted(lastIn.body_text),
    attachments: atts.map((a) => ({ filename: a.filename, contentType: a.content_type })),
    history: msgs.filter((m) => m.id !== lastIn.id).map((m) => ({ direction: m.direction, text: m.direction === "in" ? stripQuoted(m.body_text) : m.body_text, at: new Date(m.created_at).toISOString() })),
    senderVerified: ticket.sender_verified,
    context: ctx,
    moovinOff: !moovinOn,
    crmObject: crm?.object ? { object_id: crm.object.object_id, title: crm.object.title } : null,
    tools: {
      getApplicationStatus: async () => ctx,
      getObjectInfo: async (id) => (allowedListings.has(id) ? client.getListing(id) : null),
      searchKnowledge: async (q) => (await searchKnowledge(q, [...allowedListings])).map((h) => ({ title: h.title, body: h.body, scope: h.scope === "global" ? "allgemein" : `Objekt ${h.object_id}` })),
    },
  };

  let out: AgentOutput;
  let aiError: string | null = null;
  try {
    out = demoMode() ? await runDemoAgent(input) : await runClaudeAgent(input);
  } catch (e) {
    aiError = (e as Error).message;
    out = await runDemoAgent(input);
    out.result.needs_human = true;
    out.result.needs_human_reason = `KI-Fehler, Fallback auf Regeln: ${aiError}`.slice(0, 300);
    out.result.confidence = Math.min(out.result.confidence, 0.3);
  }
  const r = out.result;
  if (!INTENTS.includes(r.intent)) r.intent = "sonstiges";
  r.confidence = Math.max(0, Math.min(1, Number(r.confidence) || 0));
  if (moovinError) { r.needs_human = true; r.needs_human_reason = `moovin nicht erreichbar: ${moovinError}`; }
  if (warnings.length) {
    r.needs_human = true;
    r.needs_human_reason = [r.needs_human_reason, ...warnings].filter(Boolean).join("; ").slice(0, 500);
    for (const w of warnings) await addNote(ticketId, "system", w, "system");
  }
  // Rückfrage an den Bewerber? (Fallback, falls das Modell das Feld nicht liefert: Fragezeichen im Antworttext nach der Anrede)
  if (typeof r.awaits_reply !== "boolean") r.awaits_reply = /\?\s*$/m.test(r.reply_text.split("\n").slice(1).join("\n"));

  // Aktionen serverseitig prüfen: nur IDs aus dem Kontext dieses Absenders, keine Duplikate.
  const appIds = new Set((ctx?.applications ?? []).map((a) => a.id));
  // Termin-Zuordnung entscheidet der Server (Referenz im Betreff, einziger offener Termin, eindeutig erwähnt) – nicht die KI
  const apptResolution = resolveAppointment(ctx, lastIn.subject ?? "", lastIn.body_text ?? "");
  const seen = new Set<string>();
  const valid: ProposedAction[] = [];
  for (const a of r.actions ?? []) {
    if (!WRITE_ACTIONS.includes(a.type)) continue;
    if (INTERNAL_ACTIONS.includes(a.type)) {
      if (!seen.has(a.type)) { seen.add(a.type); valid.push({ ...a, application_id: "", appointment_id: "", interest: "" }); }
      continue;
    }
    if (!moovinOn) {
      // Livetest ohne moovin: keine IDs, kein moovin-Aufruf – der AM bekommt nach Freigabe eine Aufgabe
      if (!MANUAL_ACTIONS.includes(a.type)) continue;
      if (a.type === "dokumente_ablegen" && !atts.length) continue;
      if (a.type === "interesse_setzen" && !["interessiert", "zurueckgezogen"].includes(a.interest)) continue;
      if (seen.has(a.type)) continue;
      seen.add(a.type);
      valid.push({ ...a, application_id: "", appointment_id: "", manual: true });
      continue;
    }
    if (!ctx) continue;
    if (["termin_bestaetigen", "termin_absagen", "termin_verschieben_wunsch"].includes(a.type)) {
      if (apptResolution.id === null) {
        r.needs_human = true;
        r.needs_human_reason = [r.needs_human_reason, apptResolution.reason].filter(Boolean).join("; ");
        r.confidence = Math.min(r.confidence, 0.5);
        continue;
      }
      a.appointment_id = apptResolution.id;
      a.application_id = ctx.applications.find((x) => x.appointment?.id === apptResolution.id)?.id ?? "";
    }
    if (a.type === "dokumente_ablegen") {
      // Dokumente liegen in moovin am Bewerber (Profil), nicht an einer Bewerbung → keine Zuordnung nötig
      if (!atts.length) continue;
      a.application_id = ""; a.appointment_id = "";
    }
    if (["interesse_setzen", "notiz"].includes(a.type) && !appIds.has(a.application_id)) continue;
    if (a.type === "interesse_setzen" && !["interessiert", "zurueckgezogen"].includes(a.interest)) continue;
    const k = `${a.type}:${a.application_id}:${a.appointment_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    valid.push(a);
  }

  await sql`update ticket.drafts set status = 'ersetzt' where ticket_id = ${ticketId} and status = 'offen'`;
  await sql`update ticket.actions set status = 'verworfen' where ticket_id = ${ticketId} and status in ('vorgeschlagen','blockiert')`;

  const [draft] = await sql`insert into ticket.drafts (ticket_id, in_message_id, model, body_text, analysis, usage)
    values (${ticketId}, ${lastIn.id}, ${out.model}, ${r.reply_text}, ${sql.json({ ...r, toolCalls: out.toolCalls, aiError } as never)}, ${out.usage ? sql.json(out.usage) : null})
    returning id`;

  for (const a of valid) {
    const blocked = !ticket.sender_verified && !NO_MOOVIN_WRITE.includes(a.type) && !a.manual;
    const label = actionLabel(a, ctx);
    await sql`insert into ticket.actions (ticket_id, draft_id, type, payload, label, status, blocked_reason, idempotency_key)
      values (${ticketId}, ${draft.id}, ${a.type}, ${sql.json(a as never)}, ${label}, ${blocked ? "blockiert" : "vorgeschlagen"},
              ${blocked ? "Absender nicht verifiziert (DKIM/DMARC) – Aktion bitte manuell in moovin prüfen" : null},
              ${`t${ticketId}-m${lastIn.id}-${a.type}-${a.application_id || a.appointment_id || (a.manual ? "manuell" : "")}`})
      on conflict (idempotency_key) do update set status = excluded.status, draft_id = excluded.draft_id, payload = excluded.payload`;
  }

  // Objekt/Bewerbung für Anzeige: aus Aktion, sonst erste Bewerbung
  const focusApp = ctx?.applications.find((a) => valid.some((v) => v.application_id === a.id || v.appointment_id === a.appointment?.id)) ?? ctx?.applications[0];

  // Zuständiger AM: aus der Bewerbung (moovin), sonst aus dem CRM (erkanntes Objekt); abwesend → Vertretung bzw. Allgemeiner Eingang
  const isAgent = async (email: string | null | undefined) =>
    email ? ((await sql`select email from ticket.agents where email = ${email.toLowerCase()} and active`)[0]?.email as string | undefined) ?? null : null;
  const amEmail = (focusApp?.account_manager_email ?? moovinAm)?.toLowerCase() ?? null;
  const known = await isAgent(amEmail);
  const crmAgent = !known && crm?.amEmail ? await isAgent(crm.amEmail) : null;
  let routingSource: string | null = ticket.routing_source ?? null;
  let routingNote: string | null = null;
  if (!ticket.assignee_email) {
    if (known) routingSource = "moovin";
    else if (crmAgent) routingSource = crm!.how === "moovin_id" ? "crm_id" : "crm_adresse";
    else {
      routingSource = null;
      routingNote = amEmail ? `AM laut moovin (${amEmail}) ist nicht im Ticketsystem freigeschaltet`
        : crm?.amEmail ? `Objekt ${crm.object?.title ?? crm.candidates[0]?.title ?? ""} gehört laut CRM zu ${crm.amName ?? crm.amEmail} – noch nicht im Ticketsystem freigeschaltet`
        : crm?.note ? crm.note
        : !moovinOn ? "Kein Objekt in der Mail erkannt (moovin-Anbindung aus)"
        : null;
    }
  }
  // Bestehende Zuständigkeit bleibt; ist der AM abwesend, übernimmt die Vertretung bzw. der Allgemeine Eingang
  const eff = await effectiveAssignee(ticket.assignee_email ?? known ?? crmAgent);
  const assignee = eff.assignee;
  const deputyFor = eff.assignee === ticket.assignee_email && ticket.assignee_email ? ticket.deputy_for : eff.deputyFor;

  const [setting] = await sql`select * from ticket.intent_settings where intent = ${r.intent}`;
  const auto =
    !!setting && setting.mode === "auto" && !setting.locked &&
    r.confidence >= Number(setting.threshold) && !r.needs_human && !!r.reply_text.trim() && !/\[AM:/.test(r.reply_text) &&
    (!!ctx || (!moovinOn && GENERAL_INTENTS.includes(r.intent))) && valid.every((a) => !a.manual) &&
    (valid.length === 0 || ticket.sender_verified) && !aiError && !moovinError;

  await sql`update ticket.tickets set
      intent = ${r.intent}, language = ${r.language}, confidence = ${r.confidence}, summary = ${r.summary},
      needs_human = ${r.needs_human}, needs_human_reason = ${r.needs_human_reason || null},
      applicant_id = ${ctx?.applicant.id ?? null}, applicant_known = ${!!ctx}, reply_to_email = ${ctx ? ticket.sender_email : null},
      application_id = ${focusApp?.id ?? null},
      object_id = ${focusApp?.listing_id ?? listingId ?? crm?.object?.object_id ?? ticket.object_id},
      object_title = ${focusApp?.object_title ?? objectTitle ?? crm?.object?.title ?? ticket.object_title},
      routing_source = ${routingSource}, routing_note = ${assignee ? null : routingNote},
      deputy_for = ${deputyFor},
      assignee_email = ${assignee},
      status = 'entwurf', updated_at = now()
    where id = ${ticketId}`;

  await audit(actor === "system" ? "ki" : actor, "ki_call", { model: out.model, intent: r.intent, confidence: r.confidence, needs_human: r.needs_human, tools: out.toolCalls, usage: out.usage, aiError, auto, moovin: moovinOn ? "an" : "aus" }, ticketId);
  if (crm?.how) await audit("system", "ticket", { event: "objekt_erkannt", how: crm.how, object: crm.object?.object_id ?? null, candidates: crm.candidates.length, am: crm.amEmail, assigned: !!crmAgent && !ticket.assignee_email }, ticketId);

  if (auto) {
    const acts = await sql`select id from ticket.actions where draft_id = ${draft.id} and status = 'vorgeschlagen'`;
    try {
      await sendDraft({ ticketId, draftId: Number(draft.id), actor: "ki", finalText: r.reply_text, actionIds: acts.map((a) => Number(a.id)), awaitReply: !!r.awaits_reply });
    } catch (e) {
      await sql`update ticket.tickets set needs_human = true, needs_human_reason = ${`Auto-Versand fehlgeschlagen: ${(e as Error).message}`.slice(0, 300)}, auto_handled = false where id = ${ticketId}`;
      await audit("ki", "ticket", { event: "auto_versand_fehler", error: (e as Error).message }, ticketId);
    }
  }
}

function actionLabel(a: ProposedAction, ctx: ApplicantContext | null): string {
  if (a.manual) {
    const pre = "Aufgabe für den AM (moovin-Anbindung aus): ";
    switch (a.type) {
      case "dokumente_ablegen": return `${pre}Anhänge in moovin am Bewerber ablegen`;
      case "termin_bestaetigen": return `${pre}Teilnahme am Besichtigungstermin in moovin bestätigen`;
      case "termin_absagen": return `${pre}Besichtigungstermin in moovin absagen und Platz freigeben`;
      case "termin_verschieben_wunsch": return `Verschiebewunsch per Mail an den AM: „${a.text.slice(0, 120)}“`;
      case "interesse_setzen": return a.interest === "zurueckgezogen" ? `${pre}Bewerbung in moovin zurückziehen` : `${pre}Interesse in moovin vermerken`;
      case "notiz": return `${pre}Notiz in moovin eintragen: „${a.text.slice(0, 140)}“`;
      default: break;
    }
  }
  const app = ctx?.applications.find((x) => x.id === a.application_id || x.appointment?.id === a.appointment_id);
  const when = app?.appointment ? new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" }).format(new Date(app.appointment.starts_at)) : "";
  switch (a.type) {
    case "dokumente_ablegen": return `Anhänge im Bewerberprofil ${ctx?.applicant.id ?? ""} ablegen`;
    case "termin_bestaetigen": return `Teilnahme am Termin ${when} bestätigen`;
    case "termin_absagen": return `Termin ${when} absagen und Slot freigeben`;
    case "termin_verschieben_wunsch": return `Verschiebewunsch für Termin ${when} per Mail an den AM: „${a.text.slice(0, 120)}“`;
    case "interesse_setzen": return a.interest === "zurueckgezogen" ? `Rückzug als Notiz an Bewerbung ${a.application_id} (${app?.object_title ?? ""}) – AM zieht in moovin zurück` : `Interesse als Notiz an Bewerbung ${a.application_id} vermerken`;
    case "notiz": return `Notiz: „${a.text.slice(0, 140)}“`;
    case "datenschutz_weiterleiten": return `An ${env.datenschutzAddress()} weiterleiten${a.text ? `: „${a.text.slice(0, 120)}“` : ""}`;
  }
}

// ---------- Versand & Aktionen ----------

export class SendConflict extends Error {}

export async function sendDraft(opts: { ticketId: number; draftId: number; actor: string; finalText: string; actionIds: number[]; awaitReply?: boolean; knownLastMessageId?: number | null; force?: boolean }) {
  const { ticketId, draftId, actor, finalText, actionIds } = opts;
  const [ticket] = await sql`select * from ticket.tickets where id = ${ticketId}`;
  const [draft] = await sql`select * from ticket.drafts where id = ${draftId} and ticket_id = ${ticketId}`;
  if (!ticket || !draft) throw new Error("Ticket/Entwurf nicht gefunden");
  // Bearbeitungssperre: hat jemand anderes geantwortet, seit der AM das Ticket geöffnet hat?
  if (opts.knownLastMessageId !== undefined && !opts.force) {
    const [newer] = await sql`select m.sent_by, m.created_at from ticket.messages m where m.ticket_id = ${ticketId} and m.direction = 'out'
                              and m.id > ${opts.knownLastMessageId ?? 0} order by m.id desc limit 1`;
    if (newer) throw new SendConflict(`${String(newer.sent_by).replace("am:", "")} hat zwischenzeitlich geantwortet. Trotzdem senden?`);
  }
  if (draft.status !== "offen") throw new Error("Entwurf wurde bereits bearbeitet");
  if (!finalText.trim()) throw new Error("Antwort ist leer");
  if (/\[AM:/.test(finalText)) throw new Error("Antwort enthält noch [AM: …]-Platzhalter");
  if (ticket.merged_into) throw new Error(`Ticket wurde in T-${ticket.merged_into} zusammengeführt`);

  // Empfänger: IMMER die in moovin hinterlegte Adresse; unbekannte Absender bekommen nur generische Antworten an ihre Absenderadresse
  const to = ticket.reply_to_email ?? ticket.sender_email;
  const lastIn = (await sql`select * from ticket.messages where ticket_id = ${ticketId} and direction = 'in' order by created_at desc limit 1`)[0];
  const baseSubject = String(ticket.subject ?? "Ihre Anfrage").replace(/\s*\[#T-\d+\]/g, "").replace(/^((re|aw|wg|fwd?):\s*)+/i, "");
  const subject = `Re: ${baseSubject} [#T-${ticketId}]`;
  const messageId = newMessageId(ticketId);
  const references = [lastIn?.references_hdr, lastIn?.mail_message_id].filter(Boolean).join(" ") || null;

  const { delivery, providerMessageId } = await sendMailDetailed({ to, subject, text: finalText, inReplyTo: lastIn?.mail_message_id ?? null, references, messageId, ticketId });
  if (delivery === "fehler") throw new Error("Versand fehlgeschlagen – bitte erneut versuchen");

  await sql`insert into ticket.messages (ticket_id, direction, from_email, to_email, subject, body_text, mail_message_id, provider_message_id, in_reply_to, references_hdr, sent_by, delivery_status)
    values (${ticketId}, 'out', ${env.inboundAddress()}, ${to}, ${subject}, ${finalText}, ${messageId}, ${providerMessageId}, ${lastIn?.mail_message_id ?? null}, ${references}, ${actor}, ${delivery})`;

  const sim = similarity(draft.body_text, finalText);
  await sql`update ticket.drafts set status = 'gesendet', final_text = ${finalText}, similarity = ${sim}, unchanged = ${sim >= UNCHANGED_THRESHOLD},
            decided_by = ${actor}, decided_at = now() where id = ${draftId}`;

  // Aktionen: ausgewählte ausführen, übrige verwerfen
  const acts = await sql`select * from ticket.actions where draft_id = ${draftId}`;
  const results: { id: number; ok: boolean; error?: string }[] = [];
  for (const a of acts) {
    if (a.status !== "vorgeschlagen") continue;
    if (!actionIds.includes(Number(a.id))) {
      await sql`update ticket.actions set status = 'verworfen', executed_by = ${actor}, executed_at = now() where id = ${a.id}`;
      continue;
    }
    results.push(await executeAction(Number(a.id), actor));
  }

  const wait = !!opts.awaitReply;
  await sql`update ticket.tickets set status = ${wait ? "wartet" : "beantwortet"}, auto_handled = ${actor === "ki"},
            waiting_since = ${wait ? new Date() : null}, waiting_reminded_at = null, due_at = case when ${wait} then null else due_at end,
            first_response_at = coalesce(first_response_at, now()), updated_at = now() where id = ${ticketId}`;
  // Option: Kopie von Mail und Antwort im Bewerber in moovin (blockiert den Versand nie)
  const copy = await copyCorrespondence(ticketId);
  await audit(actor, "ticket", { event: wait ? "rueckfrage_gesendet" : "beantwortet", draftId, delivery, similarity: sim, actions: results, copy }, ticketId);
  return { delivery, results };
}

export async function executeAction(actionId: number, actor: string): Promise<{ id: number; ok: boolean; error?: string }> {
  const [a] = await sql`select a.*, t.sender_email, t.sender_verified, t.applicant_id, t.assignee_email from ticket.actions a join ticket.tickets t on t.id = a.ticket_id where a.id = ${actionId}`;
  if (!a) return { id: actionId, ok: false, error: "nicht gefunden" };
  if (a.status !== "vorgeschlagen") return { id: actionId, ok: false, error: `Status ${a.status}` };
  const p = a.payload as ProposedAction;
  // Schreibaufrufe an moovin nur für verifizierte Absender; manuelle Aufgaben (moovin-Anbindung aus) prüft der AM selbst
  if (!a.sender_verified && !NO_MOOVIN_WRITE.includes(a.type) && !p.manual) {
    await sql`update ticket.actions set status = 'blockiert', blocked_reason = 'Absender nicht verifiziert' where id = ${actionId}`;
    return { id: actionId, ok: false, error: "Absender nicht verifiziert" };
  }
  const client = new MoovinClient(a.sender_email, Number(a.ticket_id));
  const src = `T-${a.ticket_id}`;
  try {
    let result: unknown;
    // moovin-Anbindung aus: nichts an moovin senden – die Aufgabe für den AM entsteht unten (taskForAction)
    if (p.manual && a.type !== "termin_verschieben_wunsch") result = { manuell: true };
    else switch (a.type as ActionType) {
      case "dokumente_ablegen": {
        const [d] = await sql`select in_message_id from ticket.drafts where id = ${a.draft_id}`;
        const files = await sql`select id, filename, content_type, content from ticket.attachments where message_id = ${d.in_message_id}`;
        if (!a.applicant_id) throw new Error("Bewerber in moovin unbekannt");
        result = await client.post(`/applicants/${encodeURIComponent(a.applicant_id)}/documents`, {
          source_ticket_id: src,
          files: files.map((f) => ({ filename: f.filename, content_type: f.content_type, content_base64: Buffer.from(f.content).toString("base64") })),
        }, a.idempotency_key);
        await sql`update ticket.attachments set forwarded_at = now() where message_id = ${d.in_message_id}`;
        break;
      }
      case "termin_bestaetigen":
        result = await client.post(`/appointments/${encodeURIComponent(p.appointment_id)}/reply`, { source_ticket_id: src, answer: "zusage" }, a.idempotency_key);
        break;
      case "termin_absagen":
        result = await client.post(`/appointments/${encodeURIComponent(p.appointment_id)}/reply`, { source_ticket_id: src, answer: "absage", comment: "Absage per Mail" }, a.idempotency_key);
        break;
      case "termin_verschieben_wunsch": {
        // Kein moovin-Aufruf: das Ticketsystem schreibt dem zuständigen AM direkt eine Mail
        if (!a.assignee_email) throw new Error("Kein zuständiger AM – Verschiebewunsch bitte manuell weitergeben");
        const text = [
          "Verschiebewunsch per Mail aus dem moovin Ticketsystem.",
          "",
          `Bewerber: ${a.sender_email}`,
          String(a.label ?? "").replace(/ per Mail an den AM.*$/, ""),
          `Wunsch: ${String(p.text || "Verschiebung gewünscht").slice(0, 1000)}`,
          "",
          `Ticket: ${env.appUrl()}/tickets/${a.ticket_id}`,
        ].join("\n");
        const delivery = await sendMail({ to: a.assignee_email, subject: `[Verschiebewunsch] ${a.sender_email} [#T-${a.ticket_id}]`, text, messageId: newMessageId(Number(a.ticket_id)), ticketId: Number(a.ticket_id) });
        if (delivery === "fehler") throw new Error(`Mail an ${a.assignee_email} fehlgeschlagen`);
        result = { notified: a.assignee_email, delivery };
        break;
      }
      case "interesse_setzen":
        // Kein eigener Endpunkt: als Notiz an die Bewerbung, der AM setzt den Status in moovin
        result = await client.post(`/applications/${encodeURIComponent(p.application_id)}/notes`, {
          source_ticket_id: src,
          text: p.interest === "zurueckgezogen" ? `Bewerber zieht die Bewerbung per Mail zurück. ${p.text ?? ""}`.trim() : `Bewerber bestätigt per Mail sein Interesse. ${p.text ?? ""}`.trim(),
          ticket_url: `${env.appUrl()}/tickets/${a.ticket_id}`,
        }, a.idempotency_key);
        break;
      case "datenschutz_weiterleiten": {
        const [m] = await sql`select m.from_email, m.from_name, m.subject, m.body_text, m.created_at, m.sender_verified
                              from ticket.drafts d join ticket.messages m on m.id = d.in_message_id where d.id = ${a.draft_id}`;
        const to = env.datenschutzAddress();
        const text = [
          "Weitergeleitete Datenschutzanfrage aus dem moovin Ticketsystem.",
          "",
          `Ticket: ${env.appUrl()}/tickets/${a.ticket_id}`,
          `Absender: ${m?.from_name ? `${m.from_name} ` : ""}<${m?.from_email ?? a.sender_email}>`,
          `Absender verifiziert (DKIM/DMARC): ${m?.sender_verified ? "ja" : "nein – Identität bitte vor Löschung/Auskunft prüfen"}`,
          `Eingang: ${m?.created_at ? new Date(m.created_at).toISOString() : "–"}`,
          p.text ? `Zusammenfassung: ${p.text}` : "",
          "",
          `Betreff: ${m?.subject ?? ""}`,
          "----- Originalnachricht -----",
          String(m?.body_text ?? "").slice(0, 20_000),
        ].join("\n");
        const delivery = await sendMail({ to, subject: `[Datenschutz] Anfrage von ${a.sender_email} [#T-${a.ticket_id}]`, text, messageId: newMessageId(Number(a.ticket_id)), ticketId: Number(a.ticket_id) });
        if (delivery === "fehler") throw new Error(`Weiterleitung an ${to} fehlgeschlagen`);
        result = { forwarded_to: to, delivery };
        break;
      }
      case "notiz":
        result = await client.post(`/applications/${encodeURIComponent(p.application_id)}/notes`, { source_ticket_id: src, text: String(p.text || "Mail ohne Zusammenfassung").slice(0, 4000), ticket_url: `${env.appUrl()}/tickets/${a.ticket_id}` }, a.idempotency_key);
        break;
    }
    await sql`update ticket.actions set status = 'ausgefuehrt', result = ${sql.json((result ?? {}) as never)}, executed_by = ${actor}, executed_at = now() where id = ${actionId}`;
    await audit(actor, "action", { type: a.type, ok: true }, Number(a.ticket_id));
    await taskForAction({ id: actionId, ticket_id: Number(a.ticket_id), type: a.type, payload: p, label: a.label, assignee_email: a.assignee_email });
    return { id: actionId, ok: true };
  } catch (e) {
    const msg = (e as Error).message;
    await sql`update ticket.actions set status = 'fehler', result = ${sql.json({ error: msg })}, executed_by = ${actor}, executed_at = now() where id = ${actionId}`;
    await audit(actor, "action", { type: a.type, ok: false, error: msg }, Number(a.ticket_id));
    return { id: actionId, ok: false, error: msg };
  }
}

export async function closeTicket(ticketId: number, actor: string) {
  await sql`update ticket.drafts set status = 'verworfen', decided_by = ${actor}, decided_at = now() where ticket_id = ${ticketId} and status = 'offen'`;
  await sql`update ticket.actions set status = 'verworfen' where ticket_id = ${ticketId} and status in ('vorgeschlagen','blockiert')`;
  await sql`update ticket.tickets set status = 'geschlossen', closed_at = now(), updated_at = now() where id = ${ticketId}`;
  await audit(actor, "ticket", { event: "geschlossen" }, ticketId);
}
