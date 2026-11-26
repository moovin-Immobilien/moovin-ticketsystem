import "server-only";
import { env } from "./env";
import { audit } from "./audit";
import { sql } from "./db";
import { withSignature } from "./signature";

export type OutMail = { to: string; subject: string; text: string; html?: string; inReplyTo?: string | null; references?: string | null; messageId: string; ticketId: number };
export type Delivery = "gesendet" | "simuliert" | "fehler";

function parseFrom(from: string): { name: string; email: string } {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].replace(/^"|"$/g, ""), email: m[2].trim() } : { name: "", email: from.trim() };
}

/**
 * Versand über den Dienst aus MAIL_PROVIDER (brevo | postmark). Ohne Zugangsdaten wird nur simuliert.
 * Brevo erlaubt keine Standard-Header (Message-ID, In-Reply-To) → Brevo vergibt die Message-ID selbst; wir speichern sie
 * (providerMessageId), damit Antworten über In-Reply-To wieder zum Ticket finden. Zusätzlich steht [#T-…] im Betreff.
 */
async function deliver(m: OutMail): Promise<{ delivery: Delivery; providerMessageId: string | null }> {
  const provider = env.mailProvider();
  if (provider === "brevo" && env.brevoApiKey()) {
    const from = parseFrom(env.fromAddress());
    try {
      const res = await fetch(`${env.brevoApiBase()}/v3/smtp/email`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "api-key": env.brevoApiKey() },
        body: JSON.stringify({
          sender: { email: from.email, ...(from.name ? { name: from.name } : {}) },
          to: [{ email: m.to }],
          replyTo: { email: env.inboundAddress() },
          subject: m.subject,
          textContent: m.text,
          ...(m.html ? { htmlContent: m.html } : {}),
          headers: { "X-Moovin-Ticket": `T-${m.ticketId}`, "X-Moovin-Ref": m.messageId, IdempotencyKey: m.messageId },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json().catch(() => ({}))) as { messageId?: string };
      await audit("system", "mail_out", { to: m.to, subject: m.subject, mode: "brevo", status: res.status }, m.ticketId);
      return { delivery: res.ok ? "gesendet" : "fehler", providerMessageId: res.ok ? data.messageId ?? null : null };
    } catch (e) {
      await audit("system", "mail_out", { to: m.to, subject: m.subject, mode: "brevo", error: (e as Error).message }, m.ticketId);
      return { delivery: "fehler", providerMessageId: null };
    }
  }
  if (provider === "postmark" && env.postmarkToken()) {
    const headers = [{ Name: "Message-ID", Value: m.messageId }];
    if (m.inReplyTo) headers.push({ Name: "In-Reply-To", Value: m.inReplyTo });
    if (m.references) headers.push({ Name: "References", Value: m.references });
    try {
      const res = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": env.postmarkToken() },
        body: JSON.stringify({ From: env.fromAddress(), To: m.to, ReplyTo: env.inboundAddress(), Subject: m.subject, TextBody: m.text, ...(m.html ? { HtmlBody: m.html } : {}), Headers: headers, MessageStream: "outbound" }),
        signal: AbortSignal.timeout(15_000),
      });
      await audit("system", "mail_out", { to: m.to, subject: m.subject, mode: "postmark", status: res.status }, m.ticketId);
      return { delivery: res.ok ? "gesendet" : "fehler", providerMessageId: null };
    } catch (e) {
      await audit("system", "mail_out", { to: m.to, subject: m.subject, mode: "postmark", error: (e as Error).message }, m.ticketId);
      return { delivery: "fehler", providerMessageId: null };
    }
  }
  await audit("system", "mail_out", { to: m.to, subject: m.subject, mode: "simuliert", provider }, m.ticketId);
  return { delivery: "simuliert", providerMessageId: null };
}

/**
 * Antwort an Bewerber (nur sendDraft): hängt die moovin-Signatur an (Hilfecenter, Firmenangaben, Datenschutz)
 * und verschickt Text + HTML. Sprache des Fußes nach ticket.language. Gespeichert wird weiter nur der Antworttext.
 */
export async function sendMailDetailed(m: OutMail): Promise<{ delivery: Delivery; providerMessageId: string | null }> {
  const [t] = await sql`select language from ticket.tickets where id = ${m.ticketId}`;
  const signed = withSignature(m.text, (t?.language as string | null) ?? null);
  return deliver({ ...m, text: signed.text, html: signed.html });
}

/** Interne Mails (Verschiebewunsch an AM, Datenschutz-Weiterleitung): ohne Signatur, nur Text. */
export async function sendMail(m: OutMail): Promise<Delivery> {
  return (await deliver(m)).delivery;
}
