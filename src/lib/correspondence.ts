import "server-only";
import { sql } from "./db";
import { env } from "./env";
import { audit } from "./audit";
import { MoovinClient } from "./moovin/client";

/**
 * Option: Kopie von Bewerber-Mail(s) und unserer Antwort im Bewerber in moovin ablegen,
 * damit AMs den Verlauf auch in moovin sehen. Läuft nach jedem Versand, blockiert ihn aber nie.
 * Übertragen werden alle Nachrichten des Tickets, die noch nicht kopiert wurden. Anhänge nur als Dateinamen
 * (die Dateien selbst gehen über /documents ins Profil).
 */
export async function copyCorrespondence(ticketId: number): Promise<{ ok: boolean; stored?: number; error?: string; skipped?: string }> {
  if (!env.copyCorrespondence()) return { ok: true, skipped: "deaktiviert" };
  const [t] = await sql`select id, sender_email, applicant_id, application_id from ticket.tickets where id = ${ticketId}`;
  if (!t?.applicant_id) return { ok: true, skipped: "Bewerber in moovin unbekannt" };
  const msgs = await sql`select id, direction, from_email, to_email, subject, body_text, sender_verified, sent_by, created_at
                         from ticket.messages where ticket_id = ${ticketId} and copied_to_moovin_at is null order by created_at asc limit 20`;
  if (!msgs.length) return { ok: true, skipped: "nichts Neues" };
  const atts = await sql`select message_id, filename from ticket.attachments where message_id = any(${msgs.map((m) => m.id)})`;
  try {
    const res = await new MoovinClient(t.sender_email, ticketId).post(`/applicants/${encodeURIComponent(t.applicant_id)}/correspondence`, {
      source_ticket_id: `T-${ticketId}`,
      ticket_url: `${env.appUrl()}/tickets/${ticketId}`,
      application_id: t.application_id ?? null,
      messages: msgs.map((m) => ({
        direction: m.direction,
        sent_at: new Date(m.created_at).toISOString(),
        from: m.from_email,
        to: m.to_email,
        subject: m.subject ?? "",
        text: String(m.body_text ?? "").slice(0, 20_000),
        attachments: atts.filter((a) => a.message_id === m.id).map((a) => a.filename),
        ...(m.direction === "in" ? { sender_verified: !!m.sender_verified } : { sent_by: m.sent_by === "ki" ? "KI" : String(m.sent_by ?? "").replace("am:", "") }),
      })),
    }, `t${ticketId}-kopie-${msgs.at(-1)!.id}`);
    await sql`update ticket.messages set copied_to_moovin_at = now() where id = any(${msgs.map((m) => m.id)})`;
    return { ok: true, stored: Number((res as { stored?: number } | null)?.stored ?? msgs.length) };
  } catch (e) {
    const error = (e as Error).message;
    await audit("system", "moovin_api", { event: "kopie_fehlgeschlagen", error }, ticketId);
    return { ok: false, error };
  }
}
